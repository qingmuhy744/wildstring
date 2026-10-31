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
    private let queueKey = DispatchSpecificKey<UInt8>()
    /// Serial queue passed to `AVAssetResourceLoader.setDelegate`. `respond`
    /// and `finishLoading` trap unless they run on this exact queue.
    let callbackQueue = DispatchQueue(label: "wildstring.audio.loader", qos: .userInitiated)
    nonisolated(unsafe) private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    nonisolated(unsafe) private var gates: [ObjectIdentifier: RequestGate] = [:]
    nonisolated(unsafe) private var prefetchTask: Task<Void, Never>?

    /// Requests larger than this are streamed incrementally instead of being
    /// buffered in full before the first byte reaches the player.
    private static let streamingThreshold: Int64 = 256 * 1024

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
        callbackQueue.setSpecific(key: queueKey, value: 1)
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
        // Already on `callbackQueue`. Read the request here; later hops must
        // not touch it from the cooperative thread pool.
        let shape = Self.shape(of: loadingRequest, path: path)
        if case .transcode(let offset, let hasDataRequest) = shape {
            if let info = loadingRequest.contentInformationRequest {
                info.isByteRangeAccessSupported = false
                info.contentType = "public.mpeg-4-audio"
            }
            if !hasDataRequest || offset != 0 {
                loadingRequest.finishLoading()
                return true
            }
        }
        let key = ObjectIdentifier(loadingRequest)
        let gate = RequestGate()
        let request = Unchecked(loadingRequest)
        let task = Task {
            await self.handle(request.value, path: path, key: key, shape: shape, gate: gate)
        }
        lock.withLock {
            tasks[key] = task
            gates[key] = gate
        }
        return true
    }

    public func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        didCancel loadingRequest: AVAssetResourceLoadingRequest
    ) {
        let key = ObjectIdentifier(loadingRequest)
        let task = lock.withLock { () -> Task<Void, Never>? in
            gates.removeValue(forKey: key)?.cancel()
            return tasks.removeValue(forKey: key)
        }
        task?.cancel()
    }

    /// Runs `body` on the resource-loader queue and waits until it finishes.
    /// Uses `async` rather than `sync`: a synchronous hop can run inline on the
    /// calling work-queue thread, which fails `dispatch_assert_queue`.
    private func onLoaderQueue(
        _ loadingRequest: Unchecked<AVAssetResourceLoadingRequest>,
        gate: RequestGate,
        _ body: @escaping (AVAssetResourceLoadingRequest) -> Void
    ) async {
        if gate.isCancelled || Task.isCancelled { return }
        let boxedBody = Unchecked(body)
        if DispatchQueue.getSpecific(key: queueKey) != nil {
            if !gate.isCancelled { body(loadingRequest.value) }
            return
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            callbackQueue.async {
                if !gate.isCancelled {
                    boxedBody.value(loadingRequest.value)
                }
                continuation.resume()
            }
        }
    }

    /// Orders work onto the loader queue without waiting. Safe from a
    /// non-async URLSession header callback; the serial queue keeps it ahead
    /// of later chunk replies.
    private func enqueue(
        _ loadingRequest: Unchecked<AVAssetResourceLoadingRequest>,
        gate: RequestGate,
        _ body: @escaping (AVAssetResourceLoadingRequest) -> Void
    ) {
        if gate.isCancelled { return }
        let boxedBody = Unchecked(body)
        let work: @Sendable () -> Void = {
            if gate.isCancelled { return }
            boxedBody.value(loadingRequest.value)
        }
        if DispatchQueue.getSpecific(key: queueKey) != nil {
            work()
        } else {
            callbackQueue.async(execute: work)
        }
    }

    private func handle(
        _ loadingRequest: AVAssetResourceLoadingRequest,
        path: String,
        key: ObjectIdentifier,
        shape: RequestShape,
        gate: RequestGate
    ) async {
        let boxed = Unchecked(loadingRequest)
        defer {
            lock.withLock {
                tasks.removeValue(forKey: key)
                gates.removeValue(forKey: key)
            }
        }
        do {
            switch shape {
            case .transcode:
                try await serveTranscode(boxed, path: path, gate: gate)
            case .bytes(let offset, let length):
                if let cached = await cache?.cachedChunk(key: path, offset: offset, length: length)
                {
                    let payload = cached.data
                    let totalLength = cached.totalLength
                    let contentType = cached.contentType
                    await onLoaderQueue(boxed, gate: gate) { request in
                        Self.deliver(
                            request,
                            data: payload,
                            totalLength: totalLength,
                            contentType: contentType
                        )
                    }
                    return
                }
                if length > Self.streamingThreshold {
                    try await serveStream(
                        boxed,
                        path: path,
                        start: offset,
                        length: length,
                        gate: gate
                    )
                    return
                }
                let chunk = try await fetcher.fetch(
                    path: path,
                    offset: offset,
                    length: length
                )
                let payload = chunk.data
                let totalLength = chunk.totalLength
                let contentType = chunk.contentType
                await onLoaderQueue(boxed, gate: gate) { request in
                    Self.deliver(
                        request,
                        data: payload,
                        totalLength: totalLength,
                        contentType: contentType
                    )
                }
                try? await cache?.store(
                    key: path,
                    offset: offset,
                    data: chunk.data,
                    totalLength: chunk.totalLength,
                    contentType: chunk.contentType
                )
            case .infoOnly:
                let probe = try await fetcher.probe(path: path)
                let totalLength = probe.totalLength
                let contentType = probe.contentType
                await onLoaderQueue(boxed, gate: gate) { request in
                    if let info = request.contentInformationRequest {
                        Self.fill(
                            info,
                            totalLength: totalLength,
                            contentType: contentType
                        )
                    }
                    request.finishLoading()
                }
            case .empty:
                await onLoaderQueue(boxed, gate: gate) { $0.finishLoading() }
            }
        } catch {
            let failure = SendableError(error)
            await onLoaderQueue(boxed, gate: gate) { request in
                request.finishLoading(with: failure.underlying)
            }
        }
    }

    private enum RequestShape: Sendable {
        case transcode(offset: Int64, hasDataRequest: Bool)
        case bytes(offset: Int64, length: Int64)
        case infoOnly
        case empty
    }

    private static func shape(
        of loadingRequest: AVAssetResourceLoadingRequest,
        path: String
    ) -> RequestShape {
        if path.contains("format=aac") {
            let dataRequest = loadingRequest.dataRequest
            return .transcode(
                offset: dataRequest?.requestedOffset ?? 0,
                hasDataRequest: dataRequest != nil
            )
        }
        if let dataRequest = loadingRequest.dataRequest {
            return .bytes(
                offset: dataRequest.requestedOffset,
                length: Int64(dataRequest.requestedLength)
            )
        }
        if loadingRequest.contentInformationRequest != nil { return .infoOnly }
        return .empty
    }

    private static func deliver(
        _ loadingRequest: AVAssetResourceLoadingRequest,
        data: Data,
        totalLength: Int64?,
        contentType: String?
    ) {
        if let info = loadingRequest.contentInformationRequest {
            fill(info, totalLength: totalLength, contentType: contentType)
        }
        loadingRequest.dataRequest?.respond(with: data)
        loadingRequest.finishLoading()
    }

    /// Warms the connection and caches the leading bytes before the player asks,
    /// cutting the startup round trips (sniff, first range) to cache hits.
    public func prefetch(path: String, bytes: Int64 = 512 * 1024) {
        prefetchTask?.cancel()
        let fetcher = self.fetcher
        let cache = self.cache
        prefetchTask = Task {
            guard let chunk = try? await fetcher.fetch(path: path, offset: 0, length: bytes),
                !Task.isCancelled
            else { return }
            try? await cache?.store(
                key: path,
                offset: 0,
                data: chunk.data,
                totalLength: chunk.totalLength,
                contentType: chunk.contentType
            )
        }
    }

    /// Streams a large range response incrementally so playback can start on
    /// the first chunks instead of waiting for the whole range.
    private func serveStream(
        _ loadingRequest: Unchecked<AVAssetResourceLoadingRequest>,
        path: String,
        start: Int64,
        length: Int64,
        gate: RequestGate
    ) async throws {
        let sent = CounterBox()
        try await fetcher.stream(
            path: path,
            range: start > 0 ? "bytes=\(start)-" : nil,
            onResponse: { response in
                let totalLength = AudioRangeFetcher.totalLength(of: response)
                let contentType = response.value(forHTTPHeaderField: "Content-Type")
                self.enqueue(loadingRequest, gate: gate) { request in
                    if let info = request.contentInformationRequest {
                        Self.fill(info, totalLength: totalLength, contentType: contentType)
                    }
                }
            }
        ) { chunk in
            if Task.isCancelled || gate.isCancelled { return false }
            var data = chunk
            if length != Int64.max, sent.value + Int64(data.count) > length {
                data = data.prefix(Int(length - sent.value))
            }
            guard !data.isEmpty else { return false }
            let payload = Data(data)
            await self.onLoaderQueue(loadingRequest, gate: gate) { request in
                request.dataRequest?.respond(with: payload)
            }
            sent.value += Int64(payload.count)
            return sent.value < length && !gate.isCancelled
        }
        await onLoaderQueue(loadingRequest, gate: gate) { $0.finishLoading() }
    }

    /// Serves an AAC transcode: a non-seekable progressive stream that is
    /// consumed sequentially; seeking reloads the plan with a new start_ms.
    /// Content info and the offset check already ran on the loader queue.
    private func serveTranscode(
        _ loadingRequest: Unchecked<AVAssetResourceLoadingRequest>,
        path: String,
        gate: RequestGate
    ) async throws {
        try await fetcher.stream(path: path) { chunk in
            if Task.isCancelled || gate.isCancelled { return false }
            let payload = chunk
            await self.onLoaderQueue(loadingRequest, gate: gate) { request in
                request.dataRequest?.respond(with: payload)
            }
            return !gate.isCancelled
        }
        await onLoaderQueue(loadingRequest, gate: gate) { $0.finishLoading() }
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

private final class CounterBox: @unchecked Sendable {
    var value: Int64 = 0
}

/// Cancellation shared by the delegate queue and the fetching task.
private final class RequestGate: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }
}

private struct SendableError: @unchecked Sendable {
    let underlying: Error

    init(_ error: Error) {
        underlying = error
    }
}
