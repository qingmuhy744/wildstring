import Foundation
import SwiftData
import Testing
@testable import CorePlayback

private func queueItem(_ suffix: String, hasCover: Bool = false) -> PlaybackService.Item {
    PlaybackService.Item(
        trackID: "t\(suffix)",
        title: "Title \(suffix)",
        artist: "Artist",
        hasCover: hasCover,
        streamPath: "api/v1/tracks/t\(suffix)/stream"
    )
}

@Suite("QueueStore", .serialized)
struct QueueStoreTests {
    @Test func inMemoryStoreRoundTripsQueueAndProgress() async throws {
        let store = InMemoryQueueStore()
        let items = [queueItem("a"), queueItem("b")]
        try await store.saveQueue(items, currentIndex: 1)
        try await store.saveProgress(QueueProgress(index: 1, position: 42.5))
        let loaded = try #require(try await store.load())
        #expect(loaded.items == items)
        #expect(loaded.currentIndex == 1)
        #expect(loaded.position == 42.5)
        try await store.clear()
        #expect(try await store.load() == nil)
    }

    @Test func swiftDataStoreRoundTripsQueueAndProgress() async throws {
        let store = try SwiftDataQueueStore.inMemory()
        let items = [queueItem("a", hasCover: true), queueItem("b"), queueItem("a")]
        try await store.saveQueue(items, currentIndex: 2)
        try await store.saveProgress(QueueProgress(index: 2, position: 12.25))
        let loaded = try #require(try await store.load())
        #expect(loaded.items == items)
        #expect(loaded.items[0].hasCover)
        #expect(loaded.currentIndex == 2)
        #expect(loaded.position == 12.25)
    }

    @Test func swiftDataStoreSharesStateAcrossInstances() async throws {
        let container = try SwiftDataQueueStore.inMemoryContainer()
        let first = SwiftDataQueueStore(container: container)
        try await first.saveQueue([queueItem("a")], currentIndex: 0)
        let second = SwiftDataQueueStore(container: container)
        let loaded = try #require(try await second.load())
        #expect(loaded.items.map(\.trackID) == ["ta"])
    }

    @Test func swiftDataStoreIsolatesConnectionSpaces() async throws {
        let container = try SwiftDataQueueStore.inMemoryContainer()
        let first = SwiftDataQueueStore(container: container, space: "a")
        let second = SwiftDataQueueStore(container: container, space: "b")
        try await first.saveQueue([queueItem("a")], currentIndex: 0)
        try await second.saveQueue([queueItem("b")], currentIndex: 0)
        #expect(try await first.load()?.items.map(\.trackID) == ["ta"])
        #expect(try await second.load()?.items.map(\.trackID) == ["tb"])
        try await first.clear()
        #expect(try await first.load() == nil)
        #expect(try await second.load() != nil)
    }

    @Test func swiftDataStoreClearsEverything() async throws {
        let store = try SwiftDataQueueStore.inMemory()
        try await store.saveQueue([queueItem("a")], currentIndex: 0)
        try await store.clear()
        #expect(try await store.load() == nil)
    }
}
