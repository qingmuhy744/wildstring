import Foundation
import Testing
@testable import CorePlayback

@Suite("AudioDiskCache", .serialized)
struct AudioDiskCacheTests {
    private func makeCache(limitBytes: Int64 = 1_000_000) throws -> AudioDiskCache {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("audio-cache-\(UUID().uuidString)")
        return AudioDiskCache(directory: directory, limitBytes: limitBytes)
    }

    @Test func storesAndServesExactRanges() async throws {
        let cache = try makeCache()
        try await cache.store(
            key: "t1",
            offset: 100,
            data: Data(repeating: 7, count: 50),
            totalLength: 1000,
            contentType: "audio/mpeg"
        )
        let served = await cache.cachedChunk(key: "t1", offset: 100, length: 50)
        let chunk = try #require(served)
        #expect(chunk.data.count == 50)
        #expect(chunk.totalLength == 1000)
        #expect(chunk.contentType == "audio/mpeg")
        // Partial coverage falls back to the network path.
        let partial = await cache.cachedChunk(key: "t1", offset: 120, length: 50)
        #expect(partial == nil)
        let other = await cache.cachedChunk(key: "t9", offset: 100, length: 50)
        #expect(other == nil)
    }

    @Test func mergesAdjacentRanges() async throws {
        let cache = try makeCache()
        try await cache.store(
            key: "t1",
            offset: 0,
            data: Data(repeating: 1, count: 10),
            totalLength: nil,
            contentType: nil
        )
        try await cache.store(
            key: "t1",
            offset: 10,
            data: Data(repeating: 2, count: 10),
            totalLength: nil,
            contentType: nil
        )
        let served = await cache.cachedChunk(key: "t1", offset: 0, length: 20)
        #expect(try #require(served).data.count == 20)
    }

    @Test func statsCountOnlyNewlyCoveredBytes() async throws {
        let cache = try makeCache()
        try await cache.store(
            key: "t1",
            offset: 0,
            data: Data(repeating: 1, count: 10),
            totalLength: nil,
            contentType: nil
        )
        try await cache.store(
            key: "t1",
            offset: 5,
            data: Data(repeating: 2, count: 10),
            totalLength: nil,
            contentType: nil
        )
        let stats = try await cache.stats()
        #expect(stats.totalBytes == 15)
        #expect(stats.trackCount == 1)
    }

    @Test func evictsLeastRecentlyUsedTracksOverLimit() async throws {
        let cache = try makeCache(limitBytes: 100)
        try await cache.store(
            key: "t1",
            offset: 0,
            data: Data(repeating: 1, count: 80),
            totalLength: nil,
            contentType: nil
        )
        try await Task.sleep(for: .milliseconds(20))
        try await cache.store(
            key: "t2",
            offset: 0,
            data: Data(repeating: 2, count: 80),
            totalLength: nil,
            contentType: nil
        )
        let evicted = await cache.cachedChunk(key: "t1", offset: 0, length: 80)
        #expect(evicted == nil)
        let kept = await cache.cachedChunk(key: "t2", offset: 0, length: 80)
        #expect(try #require(kept).data.count == 80)
        let stats = try await cache.stats()
        #expect(stats.totalBytes == 80)
    }

    @Test func setLimitTrimsImmediately() async throws {
        let cache = try makeCache(limitBytes: 1_000)
        try await cache.store(
            key: "t1",
            offset: 0,
            data: Data(repeating: 1, count: 400),
            totalLength: nil,
            contentType: nil
        )
        try await Task.sleep(for: .milliseconds(20))
        try await cache.store(
            key: "t2",
            offset: 0,
            data: Data(repeating: 2, count: 400),
            totalLength: nil,
            contentType: nil
        )
        await cache.setLimit(500)
        let stats = try await cache.stats()
        #expect(stats.totalBytes == 400)
        let trimmed = await cache.cachedChunk(key: "t1", offset: 0, length: 400)
        #expect(trimmed == nil)
    }

    @Test func clearRemovesEverything() async throws {
        let cache = try makeCache()
        try await cache.store(
            key: "t1",
            offset: 0,
            data: Data(repeating: 1, count: 10),
            totalLength: nil,
            contentType: nil
        )
        try await cache.clear()
        let stats = try await cache.stats()
        #expect(stats.totalBytes == 0)
        #expect(stats.trackCount == 0)
        let served = await cache.cachedChunk(key: "t1", offset: 0, length: 10)
        #expect(served == nil)
    }
}
