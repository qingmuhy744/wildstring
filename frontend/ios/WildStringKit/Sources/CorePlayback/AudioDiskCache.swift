import CryptoKit
import Foundation

/// Byte-range disk cache for streamed audio, shared by the resource loader.
/// Stores fetched ranges per track and evicts least-recently-used tracks when
/// the capacity is exceeded.
public actor AudioDiskCache {
    public struct Stats: Sendable, Equatable {
        public var totalBytes: Int64
        public var trackCount: Int
    }

    public struct CachedChunk: Sendable {
        public var data: Data
        public var totalLength: Int64?
        public var contentType: String?
    }

    struct Range: Codable, Equatable {
        var start: Int64
        var length: Int64

        var end: Int64 { start + length }
    }

    struct Track: Codable {
        var file: String
        var ranges: [Range]
        var size: Int64
        var lastAccess: Date
        var totalLength: Int64?
        var contentType: String?
    }

    struct Index: Codable {
        var tracks: [String: Track] = [:]
    }

    /// Chunks larger than this are never served from (or written to) the cache.
    private static let maximumChunkBytes: Int64 = 32 * 1024 * 1024

    private let root: URL
    private let filesDirectory: URL
    private let indexURL: URL
    private var limitBytes: Int64
    private var index: Index?

    public init(directory: URL, limitBytes: Int64) {
        self.root = directory
        self.filesDirectory = directory.appendingPathComponent("files", isDirectory: true)
        self.indexURL = directory.appendingPathComponent("index.json")
        self.limitBytes = max(0, limitBytes)
    }

    public func cachedChunk(key: String, offset: Int64, length: Int64) -> CachedChunk? {
        guard length > 0, length <= Self.maximumChunkBytes else { return nil }
        var index = load()
        guard var track = index.tracks[key] else { return nil }
        let covered = Self.coverage(in: track.ranges, offset: offset, length: length)
        guard covered >= length else { return nil }
        let fileURL = filesDirectory.appendingPathComponent(track.file)
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return nil }
        defer { try? handle.close() }
        guard (try? handle.seek(toOffset: UInt64(offset))) != nil,
            let data = try? handle.read(upToCount: Int(length)),
            data.count == Int(length)
        else {
            return nil
        }
        track.lastAccess = Date()
        index.tracks[key] = track
        self.index = index
        return CachedChunk(
            data: data,
            totalLength: track.totalLength,
            contentType: track.contentType
        )
    }

    public func store(
        key: String,
        offset: Int64,
        data: Data,
        totalLength: Int64?,
        contentType: String?
    ) throws {
        guard limitBytes > 0 else { return }
        guard !data.isEmpty, Int64(data.count) <= Self.maximumChunkBytes else { return }
        var index = load()
        var track =
            index.tracks[key]
            ?? Track(
                file: Self.fileName(for: key),
                ranges: [],
                size: 0,
                lastAccess: Date(),
                totalLength: nil,
                contentType: nil
            )
        let covered = Self.coverage(in: track.ranges, offset: offset, length: Int64(data.count))
        let added = Int64(data.count) - covered

        try FileManager.default.createDirectory(
            at: filesDirectory,
            withIntermediateDirectories: true
        )
        let fileURL = filesDirectory.appendingPathComponent(track.file)
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            FileManager.default.createFile(atPath: fileURL.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: fileURL)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        try handle.write(contentsOf: data)

        track.ranges = Self.merge(
            track.ranges + [Range(start: offset, length: Int64(data.count))]
        )
        track.size += added
        if let totalLength { track.totalLength = totalLength }
        if let contentType { track.contentType = contentType }
        track.lastAccess = Date()
        index.tracks[key] = track
        self.index = index
        try save(index)
        try trim()
    }

    public func setLimit(_ bytes: Int64) {
        limitBytes = max(0, bytes)
        try? trim()
    }

    public func clear() throws {
        if FileManager.default.fileExists(atPath: filesDirectory.path) {
            try? FileManager.default.removeItem(at: filesDirectory)
        }
        index = Index()
        try save(Index())
    }

    public func stats() -> Stats {
        let index = load()
        return Stats(
            totalBytes: index.tracks.values.reduce(0) { $0 + $1.size },
            trackCount: index.tracks.count
        )
    }

    // MARK: - Internals

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
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(index)
        try data.write(to: indexURL, options: .atomic)
    }

    private func trim() throws {
        var index = load()
        var total = index.tracks.values.reduce(Int64(0)) { $0 + $1.size }
        guard total > limitBytes else { return }
        let ordered = index.tracks.sorted { $0.value.lastAccess < $1.value.lastAccess }
        for (key, track) in ordered {
            if total <= limitBytes { break }
            try? FileManager.default.removeItem(
                at: filesDirectory.appendingPathComponent(track.file)
            )
            index.tracks.removeValue(forKey: key)
            total -= track.size
        }
        self.index = index
        try save(index)
    }

    static func coverage(in ranges: [Range], offset: Int64, length: Int64) -> Int64 {
        let end = offset + length
        var total: Int64 = 0
        for range in ranges {
            let overlapStart = max(range.start, offset)
            let overlapEnd = min(range.end, end)
            if overlapEnd > overlapStart {
                total += overlapEnd - overlapStart
            }
        }
        return total
    }

    static func merge(_ ranges: [Range]) -> [Range] {
        let sorted = ranges.sorted { $0.start < $1.start }
        var merged: [Range] = []
        for range in sorted {
            if let last = merged.last, range.start <= last.end {
                let newEnd = max(last.end, range.end)
                merged[merged.count - 1] = Range(start: last.start, length: newEnd - last.start)
            } else {
                merged.append(range)
            }
        }
        return merged
    }

    static func fileName(for key: String) -> String {
        let digest = SHA256.hash(data: Data(key.utf8))
        return digest.map { String(format: "%02x", $0) }.joined() + ".bin"
    }
}
