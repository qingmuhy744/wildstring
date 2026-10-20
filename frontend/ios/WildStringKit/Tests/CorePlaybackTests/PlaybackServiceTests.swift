import CoreNetwork
import Foundation
import Testing
@testable import CorePlayback

@Suite("PlaybackService", .serialized)
@MainActor
struct PlaybackServiceTests {
    private func makeService(store: any QueueStore) throws -> PlaybackService {
        PlaybackService(
            server: try ServerAddress(input: "music.example.com"),
            store: store,
            cookieHeader: { nil }
        )
    }

    @Test func restoreLoadsPersistedQueueWithoutPlaying() async throws {
        let store = InMemoryQueueStore()
        let items = [
            PlaybackService.Item(
                trackID: "ta", title: "A", artist: "X", streamPath: "api/v1/tracks/ta/stream"
            ),
            PlaybackService.Item(
                trackID: "tb", title: "B", artist: "Y", streamPath: "api/v1/tracks/tb/stream"
            ),
        ]
        try await store.saveQueue(items, currentIndex: 1)
        try await store.saveProgress(QueueProgress(index: 1, position: 42))
        let service = try makeService(store: store)
        await service.restore()
        #expect(service.items == items)
        #expect(service.currentIndex == 1)
        #expect(service.currentItem?.trackID == "tb")
        #expect(service.currentTime == 42)
        #expect(service.isPlaying == false)
    }

    @Test func restoreWithoutPersistedQueueKeepsEmptyState() async throws {
        let service = try makeService(store: InMemoryQueueStore())
        await service.restore()
        #expect(service.items.isEmpty)
        #expect(service.currentIndex == nil)
        #expect(service.currentItem == nil)
    }

    @Test func adoptAppliesSharedQueuePaused() async throws {
        let service = try makeService(store: InMemoryQueueStore())
        let items = [
            PlaybackService.Item(
                trackID: "ta", title: "A", artist: "X", streamPath: "api/v1/tracks/ta/stream"
            ),
            PlaybackService.Item(
                trackID: "tb", title: "B", artist: "Y", streamPath: "api/v1/tracks/tb/stream"
            ),
        ]
        service.adopt(items: items, startingAt: 1, position: 30, mode: "repeat_all")
        #expect(service.items == items)
        #expect(service.currentIndex == 1)
        #expect(service.currentTime == 30)
        #expect(!service.isPlaying)
        #expect(service.repeatMode == .all)
        #expect(!service.isShuffled)
    }

    @Test func adoptShuffleModeSetsShuffleAndRepeatAll() async throws {
        let service = try makeService(store: InMemoryQueueStore())
        let items = (0..<3).map { index in
            PlaybackService.Item(
                trackID: "t\(index)",
                title: "T\(index)",
                artist: "X",
                streamPath: "api/v1/tracks/t\(index)/stream"
            )
        }
        service.adopt(items: items, startingAt: 0, position: 5, mode: "shuffle")
        #expect(service.isShuffled)
        #expect(service.repeatMode == .all)
        #expect(service.currentTime == 5)
        #expect(!service.isPlaying)
    }

    @Test func snapshotReportsQueueModeAndPosition() async throws {
        let service = try makeService(store: InMemoryQueueStore())
        let items = (0..<2).map { index in
            PlaybackService.Item(
                trackID: "t\(index)",
                title: "T\(index)",
                artist: "X",
                streamPath: "api/v1/tracks/t\(index)/stream"
            )
        }
        service.adopt(items: items, startingAt: 1, position: 12.5, mode: "repeat_one")
        var snapshot = service.playbackSnapshot()
        #expect(snapshot.trackIDs == ["t0", "t1"])
        #expect(snapshot.index == 1)
        #expect(snapshot.positionMs == 12_500)
        #expect(snapshot.mode == "repeat_one")
        #expect(snapshot.playbackState == "paused")

        service.cycleRepeatMode()
        snapshot = service.playbackSnapshot()
        #expect(snapshot.mode == "sequential")

        service.toggleShuffle()
        snapshot = service.playbackSnapshot()
        #expect(snapshot.mode == "shuffle")
    }

    @Test func playSetsQueueAndCurrentItem() async throws {
        let store = InMemoryQueueStore()
        let service = try makeService(store: store)
        let items = [
            PlaybackService.Item(
                trackID: "ta", title: "A", artist: "X", streamPath: "api/v1/tracks/ta/stream"
            ),
            PlaybackService.Item(
                trackID: "tb", title: "B", artist: "Y", streamPath: "api/v1/tracks/tb/stream"
            ),
        ]
        service.play(items: items, startingAt: 1)
        #expect(service.items == items)
        #expect(service.currentItem?.trackID == "tb")
        #expect(service.isPlaying)
        await service.flushPersistence()
        let persisted = try #require(try await store.load())
        #expect(persisted.items == items)
        service.stopAndClear()
        #expect(service.items.isEmpty)
        await service.flushPersistence()
        #expect(try await store.load() == nil)
    }
}
