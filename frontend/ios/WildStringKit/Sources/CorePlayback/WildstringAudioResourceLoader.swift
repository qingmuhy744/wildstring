import AVFoundation
import CoreNetwork
import Foundation
import UniformTypeIdentifiers

/// Serves AVPlayer requests for WildString audio by fetching authenticated byte
/// ranges through `AudioRangeFetcher` (pass-through for now, disk cache later).
public final class WildstringAudioResourceLoader: NSObject, AVAssetResourceLoaderDelegate,
    @unchecked Sendable
{
    public static let scheme = "wildstring-audio"

    private let fetcher: AudioRangeFetcher
    private let cache: AudioDiskCache?
    private let lock = NSLock()
    nonisolated(unsafe) private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]

    public init(
        server: ServerAddress,
        cookieHeader: @escaping @Sendable () async -> String?,
        configuration: URLSessionConfiguration? = nil,
        cache: AudioDiskCache? = nil
    ) {
        self.fetcher = AudioRangeFetcher(
            server: server,
            cookieHeader: cookieHeader,
            configuration: configuration
        )
        self.cache = cache
        super.init()
    }

    /// Custom-scheme URL handed to `AVURLAsset`; it must be resolved by this loader.
    public static func assetURL(server: ServerAddress, path: String) -> URL {
        var components = URLComponents(
            url: server.appending(path: path),
            resolvingAgainstBaseURL: false
        )!
        components.scheme = scheme
        return components.url!
    }

    /// API path for a custom-scheme request URL, or nil for foreign schemes.
    /// Query strings are preserved so transcode streams (`format=aac&start_ms=…`)
    /// survive the trip through the custom scheme.
    public static func requestPath(from url: URL?) -> String? {
        guard let url, url.scheme == scheme else { return nil }
        var path = url.path
        while path.hasPrefix("/") { path.removeFirst() }
        if let query = url.query, !query.isEmpty {
            path += "?" + query
        }
        return path
    }

    /// Uniform type identifier for the server-reported MIME type.
    static func uti(forMimeType mimeType: String) -> String {
        if let type = UTType(mimeType: mimeType) {
            return type.identifier
        }
        if mimeType == "audio/flac" {
            return "org.xiph.flac"
        }
        return UTType.audio.identifier
    }

    public func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        guard let path = Self.requestPath(from: loadingRequest.request.url) else {
            return false
        }
        let key = ObjectIdentifier(loadingRequest)
        let request = Unchecked(loadingRequest)
        let task = Task {
            await self.handle(request.value, path: path, key: key)
        }
        lock.withLock { tasks[key] = task }
        return true
    }

    public func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        didCancel loadingRequest: AVAssetResourceLoadingRequest
    ) {
        let key = ObjectIdentifier(loadingRequest)
        let task = lock.withLock { tasks.removeValue(forKey: key) }
        task?.cancel()
    }

    private func handle(
        _ loadingRequest: AVAssetResourceLoadingRequest,
        path: String,
        key: ObjectIdentifier
    ) async {
        defer { lock.withLock { _ = tasks.removeValue(forKey: key) } }
        do {
            if path.contains("format=aac") {
                try await serveTranscode(loadingRequest, path: path)
                return
            }
            if let dataRequest = loadingRequest.dataRequest {
                let offset = dataRequest.requestedOffset
                let length = Int64(dataRequest.requestedLength)
                if let cached = await cache?.cachedChunk(key: path, offset: offset, length: length)
                {
                    if Task.isCancelled { return }
                    if let info = loadingRequest.contentInformationRequest {
                        Self.fill(
                            info,
                            totalLength: cached.totalLength,
                            contentType: cached.contentType
                        )
                    }
                    dataRequest.respond(with: cached.data)
                    loadingRequest.finishLoading()
                    return
                }
                let chunk = try await fetcher.fetch(
                    path: path,
                    offset: offset,
                    length: length
                )
                if Task.isCancelled { return }
                if let info = loadingRequest.contentInformationRequest {
                    Self.fill(
                        info,
                        totalLength: chunk.totalLength,
                        contentType: chunk.contentType
                    )
                }
                dataRequest.respond(with: chunk.data)
                loadingRequest.finishLoading()
                try? await cache?.store(
                    key: path,
                    offset: offset,
                    data: chunk.data,
                    totalLength: chunk.totalLength,
                    contentType: chunk.contentType
                )
            } else if let info = loadingRequest.contentInformationRequest {
                let probe = try await fetcher.probe(path: path)
                if Task.isCancelled { return }
                Self.fill(
                    info,
                    totalLength: probe.totalLength,
                    contentType: probe.contentType
                )
                loadingRequest.finishLoading()
            } else {
                loadingRequest.finishLoading()
            }
        } catch {
            if Task.isCancelled { return }
            loadingRequest.finishLoading(with: error)
        }
    }

    /// Serves an AAC transcode: a non-seekable progressive stream that is
    /// consumed sequentially; seeking reloads the plan with a new start_ms.
    private func serveTranscode(
        _ loadingRequest: AVAssetResourceLoadingRequest,
        path: String
    ) async throws {
        if let info = loadingRequest.contentInformationRequest {
            info.isByteRangeAccessSupported = false
            info.contentType = "public.mpeg-4-audio"
        }
        guard let dataRequest = loadingRequest.dataRequest,
            dataRequest.requestedOffset == 0
        else {
            loadingRequest.finishLoading()
            return
        }
        try await fetcher.stream(path: path) { chunk in
            if Task.isCancelled { return false }
            dataRequest.respond(with: chunk)
            return true
        }
        if Task.isCancelled { return }
        loadingRequest.finishLoading()
    }

    private static func fill(
        _ info: AVAssetResourceLoadingContentInformationRequest,
        totalLength: Int64?,
        contentType: String?
    ) {        let mime = contentType ?? "application/octet-stream"
        info.isByteRangeAccessSupported = true
        if let totalLength, totalLength > 0 {
            info.contentLength = totalLength
        }
        info.contentType = uti(forMimeType: mime)
    }
}

private struct Unchecked<T>: @unchecked Sendable {
    let value: T

    init(_ value: T) {
        self.value = value
    }
}
