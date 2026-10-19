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
    private let lock = NSLock()
    nonisolated(unsafe) private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]

    public init(
        server: ServerAddress,
        cookieHeader: @escaping @Sendable () async -> String?,
        configuration: URLSessionConfiguration? = nil
    ) {
        self.fetcher = AudioRangeFetcher(
            server: server,
            cookieHeader: cookieHeader,
            configuration: configuration
        )
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
    public static func requestPath(from url: URL?) -> String? {
        guard let url, url.scheme == scheme else { return nil }
        var path = url.path
        while path.hasPrefix("/") { path.removeFirst() }
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
            if let dataRequest = loadingRequest.dataRequest {
                let chunk = try await fetcher.fetch(
                    path: path,
                    offset: dataRequest.requestedOffset,
                    length: Int64(dataRequest.requestedLength)
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

    private static func fill(
        _ info: AVAssetResourceLoadingContentInformationRequest,
        totalLength: Int64?,
        contentType: String?
    ) {
        let mime = contentType ?? "application/octet-stream"
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
