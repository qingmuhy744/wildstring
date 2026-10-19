import CoreNetwork
import Foundation

/// Full-track offline downloads, kept separate from the fragment cache.
/// Downloads run through a background URLSession; completed files live under
/// the given directory and are preferred by the player when present.
public actor OfflineDownloads {
    public struct Item: Codable, Sendable, Identifiable, Equatable {
        public var trackID: String
        public var title: String
        public var artist: String
        public var fileName: String
        public var receivedBytes: Int64
        public var expectedBytes: Int64
        public var sizeBytes: Int64
        public var state: String

        public var id: String { trackID }

        public var isCompleted: Bool { state == "completed" }
        public var isDownloading: Bool { state == "downloading" }
    }

    public struct TrackInfo: Sendable {
        public var id: String
        public var title: String
        public var artist: String
        public var streamPath: String

        public init(id: String, title: String, artist: String, streamPath: String) {
            self.id = id
            self.title = title
            self.artist = artist
            self.streamPath = streamPath
        }
    }

    public struct Stats: Sendable, Equatable {
        public var count: Int
        public var totalBytes: Int64

        public init(count: Int, totalBytes: Int64) {
            self.count = count
            self.totalBytes = totalBytes
        }
    }

    struct Index: Codable {
        var items: [String: Item] = [:]
    }

    private let directory: URL
    private let filesDirectory: URL
    private let indexURL: URL
    private let sessionIdentifier: String
    private let server: ServerAddress
    private let cookieHeader: @Sendable () async -> String?
    private var index: Index?
    private var session: URLSession?
    private var delegateProxy: DownloadDelegate?

    public init(
        directory: URL,
        sessionIdentifier: String,
        server: ServerAddress,
        cookieHeader: @escaping @Sendable () async -> String?
    ) {
        self.directory = directory
        self.filesDirectory = directory.appendingPathComponent("files", isDirectory: true)
        self.indexURL = directory.appendingPathComponent("index.json")
        self.sessionIdentifier = sessionIdentifier
        self.server = server
        self.cookieHeader = cookieHeader
    }

    /// File name convention shared with the playback offline lookup.
    public static func fileName(for trackID: String) -> String {
        "\(trackID).audio"
    }

    public func items() -> [Item] {
        load().items.values.sorted { ($0.title, $0.trackID) < ($1.title, $1.trackID) }
    }

    public func stats() -> Stats {
        let items = load().items.values
        return Stats(
            count: items.count,
            totalBytes: items.reduce(0) { $0 + ($1.isCompleted ? $1.sizeBytes : $1.receivedBytes) }
        )
    }

    public func download(_ track: TrackInfo) async {
        var index = load()
        if let existing = index.items[track.id], existing.isDownloading || existing.isCompleted {
            return
        }
        index.items[track.id] = Item(
            trackID: track.id,
            title: track.title,
            artist: track.artist,
            fileName: Self.fileName(for: track.id),
            receivedBytes: 0,
            expectedBytes: 0,
            sizeBytes: 0,
            state: "downloading"
        )
        self.index = index
        try? save(index)
        var request = URLRequest(url: server.appending(path: track.streamPath))
        request.timeoutInterval = 120
        if let cookie = await cookieHeader() {
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        let task = activeSession().downloadTask(with: request)
        task.taskDescription = track.id
        task.resume()
    }

    public func remove(trackID: String) async {
        var index = load()
        guard let item = index.items.removeValue(forKey: trackID) else { return }
        try? FileManager.default.removeItem(
            at: filesDirectory.appendingPathComponent(item.fileName)
        )
        self.index = index
        try? save(index)
    }

    public func clearAll() async {
        var index = load()
        for item in index.items.values {
            try? FileManager.default.removeItem(
                at: filesDirectory.appendingPathComponent(item.fileName)
            )
        }
        index = Index()
        self.index = index
        try? save(index)
    }

    public func shutdown() {
        session?.invalidateAndCancel()
        session = nil
        delegateProxy = nil
    }

    // MARK: - Session and delegate plumbing

    private func activeSession() -> URLSession {
        if let session { return session }
        let configuration = URLSessionConfiguration.background(
            withIdentifier: sessionIdentifier
        )
        configuration.sessionSendsLaunchEvents = true
        let delegate = DownloadDelegate()
        delegate.onFinish = { [weak self] trackID, location in
            Task { await self?.finish(trackID: trackID, location: location) }
        }
        delegate.onProgress = { [weak self] trackID, received, expected in
            Task { await self?.updateProgress(trackID: trackID, received: received, expected: expected) }
        }
        delegate.onComplete = { [weak self] trackID, _ in
            Task { await self?.markFailed(trackID: trackID) }
        }
        delegateProxy = delegate
        let session = URLSession(
            configuration: configuration,
            delegate: delegate,
            delegateQueue: nil
        )
        self.session = session
        return session
    }

    private func finish(trackID: String, location: URL) async {
        var index = load()
        guard var item = index.items[trackID] else { return }
        try? FileManager.default.createDirectory(
            at: filesDirectory,
            withIntermediateDirectories: true
        )
        let destination = filesDirectory.appendingPathComponent(item.fileName)
        try? FileManager.default.removeItem(at: destination)
        do {
            try FileManager.default.moveItem(at: location, to: destination)
            let attributes = try? FileManager.default.attributesOfItem(atPath: destination.path)
            item.sizeBytes = (attributes?[.size] as? NSNumber)?.int64Value ?? item.receivedBytes
            item.receivedBytes = item.sizeBytes
            item.state = "completed"
        } catch {
            item.state = "failed"
            try? FileManager.default.removeItem(at: location)
        }
        index.items[trackID] = item
        self.index = index
        try? save(index)
    }

    private func updateProgress(trackID: String, received: Int64, expected: Int64) async {
        var index = load()
        guard var item = index.items[trackID], item.isDownloading else { return }
        item.receivedBytes = received
        item.expectedBytes = max(expected, 0)
        index.items[trackID] = item
        self.index = index
    }

    private func markFailed(trackID: String) async {
        var index = load()
        guard var item = index.items[trackID], item.isDownloading else { return }
        item.state = "failed"
        index.items[trackID] = item
        self.index = index
        try? save(index)
    }

    private func load() -> Index {
        if let index { return index }
        let loaded: Index
        if let data = try? Data(contentsOf: indexURL),
            let decoded = try? JSONDecoder().decode(Index.self, from: data)
        {
            loaded = decoded
        } else {
            loaded = Index()
        }
        index = loaded
        return loaded
    }

    private func save(_ index: Index) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(index)
        try data.write(to: indexURL, options: .atomic)
    }
}

private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    var onFinish: (@Sendable (String, URL) -> Void)?
    var onProgress: (@Sendable (String, Int64, Int64) -> Void)?
    var onComplete: (@Sendable (String, String?) -> Void)?

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        guard let trackID = downloadTask.taskDescription else { return }
        // The temporary file is only guaranteed during this callback; move it now.
        let stagingDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("WildStringDownloads", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: stagingDirectory,
            withIntermediateDirectories: true
        )
        let staged = stagingDirectory.appendingPathComponent(UUID().uuidString)
        do {
            try FileManager.default.moveItem(at: location, to: staged)
            onFinish?(trackID, staged)
        } catch {
            onComplete?(trackID, error.localizedDescription)
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard let trackID = downloadTask.taskDescription else { return }
        onProgress?(trackID, totalBytesWritten, totalBytesExpectedToWrite)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard let trackID = task.taskDescription, let error else { return }
        onComplete?(trackID, error.localizedDescription)
    }
}
