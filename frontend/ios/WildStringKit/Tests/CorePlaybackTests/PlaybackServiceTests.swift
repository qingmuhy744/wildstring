import CoreNetwork
import Foundation
import Testing
@testable import CorePlayback

@Suite("PlaybackService", .serialized)
@MainActor
struct PlaybackServiceTests {
    @Test func podcastSpeedDoesNotStartPausedPlaybackOrAffectMusic() async throws {
        let store = InMemoryQueueStore()
        let episode = PlaybackService.Item(trackID: "podcast_ep_e1", title: "Episode", artist: "Show",
            streamPath: "api/v1/podcasts/episodes/e1/stream")
        try await store.saveQueue([episode], currentIndex: 0)
        try await store.saveProgress(QueueProgress(index: 0, position: 42))
        let service = try makeService(store: store)
        await service.restore()
        service.setPodcastPlaybackRate(1.5)
        #expect(service.playbackRate == 1.5)
        #expect(service.player.rate == 0)
        #expect(service.currentTime == 42)
        #expect(!service.isPlaying)
        service.setPodcastPlaybackRate(.nan)
        #expect(service.podcastPlaybackRate == 1.5)
        let musicStore = InMemoryQueueStore()
        try await musicStore.saveQueue([
            PlaybackService.Item(trackID: "music", title: "Song", artist: "Artist",
                streamPath: "api/v1/tracks/music/stream")
        ], currentIndex: 0)
        let music = try makeService(store: musicStore)
        await music.restore()
        music.setPodcastPlaybackRate(2)
        #expect(music.playbackRate == 1)
        #expect(music.player.rate == 0)
    }

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

    @Test func enqueuePreservesPausedPositionAndPersistsBatchOrder() async throws {
        let store = InMemoryQueueStore()
        let items = ["a", "b"].map { PlaybackService.Item(trackID: $0, title: $0, artist: "X", streamPath: "api/v1/tracks/\($0)/stream") }
        try await store.saveQueue(items, currentIndex: 0)
        try await store.saveProgress(QueueProgress(index: 0, position: 42))
        let service = try makeService(store: store)
        await service.restore()
        let more = ["c", "d"].map { PlaybackService.Item(trackID: $0, title: $0, artist: "X", streamPath: "api/v1/tracks/\($0)/stream") }
        #expect(service.enqueue(items: more, next: true))
        #expect(service.currentItem?.id == items[0].id)
        #expect(service.currentTime == 42)
        #expect(!service.isPlaying)
        #expect(service.items.map(\.trackID) == ["a", "c", "d", "b"])
        await service.flushPersistence()
        let restored = try makeService(store: store)
        await restored.restore()
        #expect(restored.items == service.items)
        #expect(restored.currentTime == 42)
    }

    @Test func restoreWithoutPersistedQueueKeepsEmptyState() async throws {
        let service = try makeService(store: InMemoryQueueStore())
        await service.restore()
        #expect(service.items.isEmpty)
        #expect(service.currentIndex == nil)
        #expect(service.currentItem == nil)
    }

    @Test func queueReorderAndRemovalPreservePausedTrackTimeAndRestoredPosition() async throws {
        let store = InMemoryQueueStore()
        let entries = ["a", "b", "a", "c"].map {
            PlaybackService.Item(trackID: $0, title: $0, artist: "X", streamPath: "api/v1/tracks/\($0)/stream")
        }
        try await store.saveQueue(entries, currentIndex: 2)
        try await store.saveProgress(QueueProgress(index: 2, position: 42.5))
        let service = try makeService(store: store)
        await service.restore()
        service.movePlaybackEntries(fromOffsets: IndexSet(integer: 2), toOffset: 1)
        service.removeQueueEntry(at: 0)
        #expect(service.currentItem?.id == entries[2].id)
        #expect(service.currentIndex == 0)
        #expect(service.currentTime == 42.5)
        #expect(service.lyricTime == 42.5)
        #expect(!service.isPlaying)
        #expect(service.items == [entries[2], entries[1], entries[3]])
        service.removeQueueEntry(at: 0)
        #expect(service.items.count == 3)
        await service.flushPersistence()
        let restored = try makeService(store: store)
        await restored.restore()
        #expect(restored.items == service.items)
        #expect(restored.currentItem?.id == entries[2].id)
        #expect(restored.currentTime == 42.5)
        #expect(!restored.isPlaying)
    }

    @Test func persistedItemsWithoutArtworkFlagRemainReadable() throws {
        let data = #"[{"id":"00000000-0000-0000-0000-000000000001","trackID":"legacy","title":"Legacy","artist":"Artist","album":"Album","streamPath":"api/v1/tracks/legacy/stream"}]"#.data(using: .utf8)!
        let items = try JSONDecoder().decode([PlaybackService.Item].self, from: data)
        #expect(items.count == 1)
        #expect(items[0].trackID == "legacy")
        #expect(items[0].hasCover == false)
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
