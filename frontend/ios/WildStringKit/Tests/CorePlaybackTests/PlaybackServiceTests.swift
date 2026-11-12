import AVFoundation
import CoreNetwork
import Foundation
import Testing
@testable import CorePlayback

@Suite("PlaybackService", .serialized)
@MainActor
struct PlaybackServiceTests {
    @Test func missingItemsAreSkippedWithoutChangingManualSelectionOrPreviousQueue() throws {
        let service = try makeService(store: InMemoryQueueStore())
        defer { service.shutdown() }
        let missing = PlaybackService.Item(trackID: "missing", title: "Missing", artist: "Artist", streamPath: "unused", unavailableReason: "文件缺失")
        let available = PlaybackService.Item(trackID: "available", title: "Available", artist: "Artist", streamPath: "unused")
        service.play(items: [missing, available, missing], startingAt: 1)
        #expect(service.items == [available])
        #expect(service.currentIndex == 0)
        service.pause()
        service.play(items: [missing], startingAt: 0)
        #expect(service.items == [available])
        #expect(!service.wantsPlayback)
        #expect(service.errorMessage?.contains("文件缺失") == true)
        #expect(!service.enqueue(items: [missing]))
        #expect(service.items == [available])
    }

    @Test func serverSwitchShutdownPreservesQueueAndPausedPosition() async throws {
        let store = InMemoryQueueStore()
        let service = try makeService(store: store)
        let entries = ["a", "b"].map {
            PlaybackService.Item(trackID: $0, title: $0, artist: "Artist", streamPath: "unused")
        }
        service.adopt(items: entries, startingAt: 1, position: 32.289, mode: "sequential")
        service.shutdown(preservingQueue: true)
        await service.flushPersistence()
        #expect(service.items.isEmpty)
        #expect(!service.isPlaying)

        let restored = try makeService(store: store)
        await restored.restore()
        #expect(restored.items == entries)
        #expect(restored.currentIndex == 1)
        #expect(restored.currentTime == 32.289)
        #expect(!restored.isPlaying)
        restored.shutdown()
        await restored.flushPersistence()
        #expect(try await store.load() == nil)
    }

    @Test func routeSwitchKeepsEntryOrderShuffleRepeatAndProgress() async throws {
        let service = try makeService(store: InMemoryQueueStore())
        let items = ["a", "b", "a"].map { PlaybackService.Item(trackID: $0, title: $0, artist: "Artist", streamPath: "unused") }
        service.adopt(items: items, startingAt: 1, position: 91.2, mode: "shuffle")
        let snapshot = service.queue
        let next = try makeService(store: InMemoryQueueStore())
        next.restoreRouteQueue(snapshot, position: service.currentTime)
        #expect(next.queue == snapshot)
        #expect(next.currentTime == 91.2)
        #expect(next.currentItem?.id == service.currentItem?.id)
        #expect(!next.isPlaying)
        service.shutdown(); next.shutdown()
    }

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
            cookieHeader: { nil },
            // Audio loads never leave the process; see StalledAudioURLProtocol.
            resourceConfiguration: StalledAudioURLProtocol.configuration()
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
        // AVPlayer's immediate waiting/playing state varies by platform.
        // Check media assignment and the explicit pause below instead.
        #expect(service.player.currentItem != nil)
        service.togglePlayPause()
        #expect(!service.isBuffering)
        #expect(service.player.rate == 0)
        await service.flushPersistence()
        let persisted = try #require(try await store.load())
        #expect(persisted.items == items)
        service.stopAndClear()
        #expect(service.items.isEmpty)
        await service.flushPersistence()
        #expect(try await store.load() == nil)
    }

    @Test func musicRepeatAndShuffleDoNotInterceptPodcastEndingOrPreview() async throws {
        let service = try makeService(store: InMemoryQueueStore())
        defer { service.shutdown() }

        let music = [
            PlaybackService.Item(trackID: "m1", title: "Song 1", artist: "Artist", streamPath: "api/v1/tracks/m1/stream"),
            PlaybackService.Item(trackID: "m2", title: "Song 2", artist: "Artist", streamPath: "api/v1/tracks/m2/stream"),
        ]
        service.play(items: music, startingAt: 0)
        service.cycleRepeatMode()
        service.cycleRepeatMode()
        #expect(service.repeatMode == .one)
        service.toggleShuffle()
        #expect(service.isShuffled)

        let showEpisodes = [
            PodcastContinuation.Episode(id: "ep3", title: "Ep 3", chronologicalIndex: 2, isCompleted: false),
            PodcastContinuation.Episode(id: "ep2", title: "Ep 2", chronologicalIndex: 1, isCompleted: false),
            PodcastContinuation.Episode(id: "ep1", title: "Ep 1", chronologicalIndex: 0, isCompleted: false),
        ]
        service.configurePodcastContinuation(
            podcastID: "show-a",
            episodes: showEpisodes,
            preference: .init(order: .follow, skipCompleted: true, autoContinue: true)
        )

        let ep2 = PlaybackService.Item(
            trackID: "podcast_ep_ep2",
            title: "Ep 2",
            artist: "Show A",
            streamPath: "api/v1/podcasts/episodes/ep2/stream"
        )
        service.playPodcastEpisode(ep2)
        #expect(service.currentItem?.trackID == "podcast_ep_ep2")
        // Preview must ignore trailing music tracks in local queue.
        #expect(service.podcastAutoPreview().map(\.trackID) == ["podcast_ep_ep1"])

        // Ending ep2 while repeatMode == .one must NOT replay ep2 or jump to music;
        // it must follow the podcast continuation rule to ep1.
        service.handleItemEnded()
        #expect(service.currentItem?.trackID == "podcast_ep_ep1")
        #expect(!service.items.contains { $0.trackID == "podcast_ep_ep1" })

        // Even with repeatMode == .all, reaching the end of the show stops cleanly.
        service.cycleRepeatMode()
        service.cycleRepeatMode()
        #expect(service.repeatMode == .all)
        service.handleItemEnded()
        #expect(service.didFinishQueue)
        #expect(!service.isPlaying)
    }

    @Test func accountAutoContinueDisabledIsHonoredAndPreservedWhenSavingShowSetting() async throws {
        defer { StubURLProtocol.reset() }
        let suiteName = "wildstring.podcast.prefs.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        final class ServerState: @unchecked Sendable {
            let lock = NSLock()
            var prefsJSON: [String: Any] = [
                "default_action": "inbox",
                "auto_limit": 3,
                "auto_continue": false,
                "shows": [String: Any](),
            ]
            var offline = false
        }
        let state = ServerState()

        StubURLProtocol.respond { request in
            let url = try #require(request.url)
            let failing = state.lock.withLock { state.offline }
            if failing {
                throw URLError(.notConnectedToInternet)
            }
            if url.path == "/api/v1/podcasts/queue/preferences" {
                if request.httpMethod == "PUT",
                   let body = StubURLProtocol.bodyData(of: request),
                   let incoming = try JSONSerialization.jsonObject(with: body) as? [String: Any]
                {
                    state.lock.withLock { state.prefsJSON = incoming }
                }
                let payload = try state.lock.withLock {
                    try JSONSerialization.data(withJSONObject: state.prefsJSON)
                }
                return StubURLProtocol.Stub(statusCode: 200, headers: [:], body: payload)
            }
            if url.path == "/api/v1/podcasts/queue" {
                return .json(body: #"{"version":1,"device_id":"d1","items":[]}"#)
            }
            return .empty(status: 404)
        }

        let server = try ServerAddress(input: "music.example.com")
        let client = WildstringClient(
            server: server,
            store: InMemorySessionStore(),
            configuration: StubURLProtocol.configuration()
        )
        let cloud = PodcastCloudQueue(
            client: client,
            deviceID: "ios-1",
            accountKey: "https://music.example.com|alice",
            defaults: defaults
        )
        let service = try makeService(store: InMemoryQueueStore())
        defer { service.shutdown() }
        service.podcastCloud = cloud

        let showAEpisodes = [
            PodcastContinuation.Episode(id: "a2", title: "A2", chronologicalIndex: 1, isCompleted: false),
            PodcastContinuation.Episode(id: "a1", title: "A1", chronologicalIndex: 0, isCompleted: false),
        ]
        await cloud.refreshPreferences()
        // Show A has no per-show setting; it must inherit account auto_continue == false.
        #expect(cloud.showPreference("show-a").autoContinue == false)
        #expect(cloud.showPreference("show-a").continuation.autoContinue == false)
        service.configurePodcastContinuation(
            podcastID: "show-a",
            episodes: showAEpisodes,
            preference: cloud.showPreference("show-a").continuation
        )
        #expect(service.podcastAutoContinueEnabled == false)
        #expect(service.podcastAutoPreview().isEmpty)

        // Saving a setting for Show B must preserve account-level auto_continue == false.
        await cloud.updateShow(podcastID: "show-b", action: "queue_last", autoLimit: 2, order: "asc")
        let savedAutoContinue = state.lock.withLock { state.prefsJSON["auto_continue"] as? Bool }
        let savedAction = state.lock.withLock { state.prefsJSON["default_action"] as? String }
        #expect(savedAutoContinue == false)
        #expect(savedAction == "queue_last")
        #expect(cloud.showPreference("show-a").continuation.autoContinue == false)
        #expect(cloud.showPreference("show-b").continuation.autoContinue == true)
        #expect(cloud.showPreference("show-b").continuation.order == .oldestFirst)

        // Offline fallback uses Alice's cached preferences, while Bob's account is isolated.
        state.lock.withLock { state.offline = true }
        let aliceOffline = PodcastCloudQueue(
            client: client,
            deviceID: "ios-1",
            accountKey: "https://music.example.com|alice",
            defaults: defaults
        )
        await aliceOffline.refreshPreferences()
        #expect(aliceOffline.showPreference("show-a").continuation.autoContinue == false)
        #expect(aliceOffline.showPreference("show-b").continuation.order == .oldestFirst)

        let bobOffline = PodcastCloudQueue(
            client: client,
            deviceID: "ios-1",
            accountKey: "https://music.example.com|bob",
            defaults: defaults
        )
        await bobOffline.refreshPreferences()
        #expect(bobOffline.showPreference("show-a").continuation.autoContinue == true)
    }

    @Test func showLineFollowsTheShowAndDoesNotFallIntoTheQueue() async throws {
        defer { StubURLProtocol.reset() }

        final class QueueServer: @unchecked Sendable {
            let lock = NSLock()
            var version = 1
            var items: [[String: String]] = [
                ["episode_id": "ep-a1", "origin": "manual"],
                ["episode_id": "ep-b1", "origin": "manual"],
            ]
            var failShowBDetail = false
        }
        let serverState = QueueServer()

        StubURLProtocol.respond { request in
            let url = try #require(request.url)
            switch url.path {
            case "/api/v1/podcasts/queue":
                if request.httpMethod == "PUT",
                   let body = StubURLProtocol.bodyData(of: request),
                   let payload = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                   let incoming = payload["items"] as? [[String: String]]
                {
                    serverState.lock.withLock {
                        serverState.version += 1
                        serverState.items = incoming
                    }
                }
                let data = try serverState.lock.withLock {
                    try JSONSerialization.data(withJSONObject: [
                        "version": serverState.version,
                        "device_id": "ios-1",
                        "items": serverState.items,
                    ])
                }
                return StubURLProtocol.Stub(statusCode: 200, headers: [:], body: data)
            case "/api/v1/podcasts/queue/preferences":
                return .json(body: #"""
                {
                  "default_action": "inbox",
                  "auto_limit": 3,
                  "auto_continue": true,
                  "shows": {
                    "show-a": {"action": "inbox", "auto_limit": 3, "order": "follow", "skip_completed": true, "auto_continue": true},
                    "show-b": {"action": "inbox", "auto_limit": 3, "order": "asc", "skip_completed": true, "auto_continue": true}
                  }
                }
                """#)
            case "/api/v1/podcasts/episodes/ep-a1":
                return .json(body: #"{"id":"ep-a1","podcast_id":"show-a","title":"Show A Ep 1","pub_date":"2026-11-01","duration_seconds":600,"position_seconds":0,"completed":false}"#)
            case "/api/v1/podcasts/episodes/ep-b1":
                return .json(body: #"{"id":"ep-b1","podcast_id":"show-b","title":"Show B Ep 1","pub_date":"2026-11-01","duration_seconds":600,"position_seconds":0,"completed":false}"#)
            case "/api/v1/podcasts/show-b":
                if serverState.lock.withLock({ serverState.failShowBDetail }) {
                    return .json(status: 500, body: #"{"detail":"server_error"}"#)
                }
                // Newest-first from server: ep-b3 (unplayed), ep-b2 (completed), ep-b1 (oldest, currently playing).
                // With Show B order == "asc" and skip_completed == true, after ep-b1 finishes, ep-b2 is skipped and ep-b3 plays!
                return .json(body: #"""
                {
                  "podcast": {"id":"show-b","title":"Show B","author":"Host B","description":"","feed_url":"https://example.com/b.xml","followed":true,"total_episodes":3,"unplayed_episodes":2},
                  "episodes": [
                    {"id":"ep-b3","podcast_id":"show-b","title":"Show B Ep 3","pub_date":"2026-11-03","duration_seconds":600,"position_seconds":0},
                    {"id":"ep-b2","podcast_id":"show-b","title":"Show B Ep 2","pub_date":"2026-11-02","duration_seconds":600,"position_seconds":600},
                    {"id":"ep-b1","podcast_id":"show-b","title":"Show B Ep 1","pub_date":"2026-11-01","duration_seconds":600,"position_seconds":0}
                  ]
                }
                """#)
            default:
                return .empty(status: 404)
            }
        }

        let server = try ServerAddress(input: "music.example.com")
        let client = WildstringClient(
            server: server,
            store: InMemorySessionStore(),
            configuration: StubURLProtocol.configuration()
        )
        let cloud = PodcastCloudQueue(client: client, deviceID: "ios-1")
        await cloud.refresh()
        #expect(cloud.items.map(\.episodeId) == ["ep-a1", "ep-b1"])

        let service = try makeService(store: InMemoryQueueStore())
        defer { service.shutdown() }
        service.podcastCloud = cloud

        // Configure Show A initially and start playing ep-a1.
        service.configurePodcastContinuation(
            podcastID: "show-a",
            episodes: [
                PodcastContinuation.Episode(id: "ep-a1", title: "Show A Ep 1", chronologicalIndex: 1, isCompleted: false),
                PodcastContinuation.Episode(id: "ep-a0", title: "Show A Ep 0", chronologicalIndex: 0, isCompleted: false),
            ],
            preference: .init(order: .follow, skipCompleted: true, autoContinue: true)
        )
        let itemA1 = try #require(await cloud.playbackItem(for: "ep-a1"))
        service.playPodcastEpisode(itemA1)
        await service.waitForPodcastTasks()
        #expect(service.podcastLine == .show)
        #expect(service.currentItem?.trackID == "podcast_ep_ep-a1")
        // Playing from the show does not rewrite the cloud queue.
        #expect(cloud.items.map(\.episodeId) == ["ep-a1", "ep-b1"])

        // Finishing ep-a1 removes it and follows Show A. ep-b1 stays queued and does not play.
        service.handleItemEnded()
        await service.waitForPodcastTasks()
        #expect(service.currentItem?.trackID == "podcast_ep_ep-a0")
        #expect(cloud.items.map(\.episodeId) == ["ep-b1"])
        #expect(service.podcastAutoPreview().isEmpty)

        // Show A is exhausted. Do not fall through into the queue. The auto-continued episode is not queued.
        service.handleItemEnded()
        await service.waitForPodcastTasks()
        #expect(service.didFinishQueue)
        #expect(!service.isPlaying)
        #expect(cloud.items.map(\.episodeId) == ["ep-b1"])
        #expect(service.currentItem?.trackID != "podcast_ep_ep-b1")

        // Show detail load failure still removes the queued episode and reports a calm retryable error.
        serverState.lock.withLock {
            serverState.items = [["episode_id": "ep-b1", "origin": "manual"]]
            serverState.failShowBDetail = true
        }
        await cloud.refreshQueue()
        service.configurePodcastContinuation(
            podcastID: "show-a",
            episodes: [PodcastContinuation.Episode(id: "ep-a1", title: "Show A Ep 1", chronologicalIndex: 0, isCompleted: false)],
            preference: .init(order: .follow, skipCompleted: true, autoContinue: true)
        )
        let itemB1 = try #require(await cloud.playbackItem(for: "ep-b1"))
        service.playPodcastEpisode(itemB1)
        await service.waitForPodcastTasks()
        service.handleItemEnded()
        await service.waitForPodcastTasks()
        #expect(service.didFinishQueue)
        #expect(cloud.items.isEmpty)
        let episodesReadFailed = KitL10n("kit.playback.episodesReadFailed")
        #expect(service.errorMessage == episodesReadFailed)
        #expect(episodesReadFailed.contains("暂时读不到节目单集"))

        // 5. The finished episode's player item failing to load afterwards (a slow network
        // reporting late) must not replace the retryable message with a playback error.
        service.itemStatusChanged(status: .failed, error: nil)
        #expect(service.didFinishQueue)
        #expect(service.errorMessage == episodesReadFailed)
    }

    @Test func pendingListIsQueueOrderAndKeepsAnUnavailableTitle() async throws {
        defer { StubURLProtocol.reset() }
        final class PendingState: @unchecked Sendable {
            let lock = NSLock()
            var version = 1
            var notice = "queue_full"
            var queue: [[String: String]] = [
                ["episode_id": "ep-newer-head", "origin": "rule", "added_at": "2026-11-10T12:00:00Z"],
                ["episode_id": "ep-older-tail", "origin": "manual", "added_at": "2026-11-08T08:00:00Z"],
                ["episode_id": "ep-missing", "origin": "manual", "added_at": "2026-11-07T08:00:00Z"],
            ]
        }
        let state = PendingState()

        StubURLProtocol.respond { request in
            let url = try #require(request.url)
            switch url.path {
            case "/api/v1/podcasts/queue":
                if request.httpMethod == "PUT",
                   let body = StubURLProtocol.bodyData(of: request),
                   let incoming = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                   let rawItems = incoming["items"] as? [[String: String]]
                {
                    state.lock.withLock {
                        state.version += 1
                        state.notice = ""
                        state.queue = rawItems
                    }
                }
                let payload = try state.lock.withLock {
                    try JSONSerialization.data(withJSONObject: [
                        "version": state.version,
                        "device_id": "mac",
                        "notice": state.notice,
                        "items": state.queue,
                    ])
                }
                return StubURLProtocol.Stub(statusCode: 200, headers: [:], body: payload)
            default:
                if url.path == "/api/v1/podcasts/episodes/ep-missing" {
                    return .empty(status: 404)
                }
                if url.path.hasPrefix("/api/v1/podcasts/episodes/") {
                    let id = String(url.path.dropFirst("/api/v1/podcasts/episodes/".count))
                    return .json(body: #"{"id":"\#(id)","podcast_id":"show-a","title":"\#(id)"}"#)
                }
                return .empty(status: 404)
            }
        }

        let client = WildstringClient(
            server: try ServerAddress(input: "music.example.com"),
            store: InMemorySessionStore(),
            configuration: StubURLProtocol.configuration()
        )
        let cloud = PodcastCloudQueue(client: client, deviceID: "mac")
        await cloud.refreshQueue()

        #expect(cloud.unifiedPendingEpisodes.map(\.episodeId) == [
            "ep-newer-head",
            "ep-older-tail",
            "ep-missing",
        ])
        #expect(cloud.queueFullNotice == KitL10n("kit.podcast.queueBatchFull"))
        #expect(cloud.title(for: "ep-missing") == KitL10n("kit.podcast.unavailableEpisode"))
        #expect(cloud.title(for: "ep-newer-head") == "ep-newer-head")

        cloud.reorderPending(["ep-missing", "ep-older-tail", "ep-newer-head"])
        await cloud.retrySync()
        #expect(cloud.unifiedPendingEpisodes.map(\.episodeId) == [
            "ep-missing",
            "ep-older-tail",
            "ep-newer-head",
        ])
        #expect(cloud.items.allSatisfy { $0.origin == "manual" })
        #expect(cloud.queueFullNotice == nil)
        #expect(cloud.title(for: "ep-missing") == KitL10n("kit.podcast.unavailableEpisode"))
    }

    @Test func queueLineFollowsTheQueueAndStopsWithoutTheShow() async throws {
        defer { StubURLProtocol.reset() }
        final class QueueServer: @unchecked Sendable {
            let lock = NSLock()
            var version = 1
            var items: [[String: String]] = [
                ["episode_id": "ep-a", "origin": "manual"],
                ["episode_id": "ep-b", "origin": "manual"],
            ]
        }
        let serverState = QueueServer()
        StubURLProtocol.respond { request in
            let url = try #require(request.url)
            if url.path == "/api/v1/podcasts/queue" {
                if request.httpMethod == "PUT",
                   let body = StubURLProtocol.bodyData(of: request),
                   let payload = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                   let incoming = payload["items"] as? [[String: String]]
                {
                    serverState.lock.withLock {
                        serverState.version += 1
                        serverState.items = incoming
                    }
                }
                let data = try serverState.lock.withLock {
                    try JSONSerialization.data(withJSONObject: [
                        "version": serverState.version,
                        "device_id": "ios-1",
                        "notice": "",
                        "items": serverState.items,
                    ])
                }
                return StubURLProtocol.Stub(statusCode: 200, headers: [:], body: data)
            }
            if url.path.hasPrefix("/api/v1/podcasts/episodes/") {
                let id = String(url.path.dropFirst("/api/v1/podcasts/episodes/".count))
                return .json(body: #"{"id":"\#(id)","podcast_id":"show-a","title":"\#(id)"}"#)
            }
            return .empty(status: 404)
        }

        let client = WildstringClient(
            server: try ServerAddress(input: "music.example.com"),
            store: InMemorySessionStore(),
            configuration: StubURLProtocol.configuration()
        )
        let cloud = PodcastCloudQueue(client: client, deviceID: "ios-1")
        await cloud.refreshQueue()
        let service = try makeService(store: InMemoryQueueStore())
        defer { service.shutdown() }
        service.podcastCloud = cloud
        service.configurePodcastContinuation(
            podcastID: "show-a",
            episodes: [
                PodcastContinuation.Episode(id: "ep-a", title: "A", chronologicalIndex: 1),
                PodcastContinuation.Episode(id: "ep-a0", title: "A0", chronologicalIndex: 0),
            ],
            preference: .init(order: .follow, skipCompleted: true, autoContinue: true)
        )
        let itemA = try #require(await cloud.playbackItem(for: "ep-a"))
        service.playPodcastEpisode(itemA, line: .queue)
        await service.waitForPodcastTasks()
        #expect(service.podcastLine == .queue)
        #expect(cloud.items.map(\.episodeId) == ["ep-a", "ep-b"])

        service.handleItemEnded()
        await service.waitForPodcastTasks()
        #expect(service.currentItem?.trackID == "podcast_ep_ep-b")
        #expect(cloud.items.map(\.episodeId) == ["ep-b"])

        service.handleItemEnded()
        await service.waitForPodcastTasks()
        #expect(service.didFinishQueue)
        #expect(!service.isPlaying)
        #expect(cloud.items.isEmpty)
        #expect(service.currentItem?.trackID != "podcast_ep_ep-a0")
    }

    @Test func podcastEnqueueDoesNotAutoStartOrRewriteTheHead() async throws {
        defer { StubURLProtocol.reset() }
        final class QueueServer: @unchecked Sendable {
            let lock = NSLock()
            var version = 1
            var items: [[String: String]] = []
        }
        let serverState = QueueServer()
        StubURLProtocol.respond { request in
            let url = try #require(request.url)
            guard url.path == "/api/v1/podcasts/queue" else { return .empty(status: 404) }
            if request.httpMethod == "PUT",
               let body = StubURLProtocol.bodyData(of: request),
               let payload = try JSONSerialization.jsonObject(with: body) as? [String: Any],
               let incoming = payload["items"] as? [[String: String]]
            {
                serverState.lock.withLock {
                    serverState.version += 1
                    serverState.items = incoming
                }
            }
            let data = try serverState.lock.withLock {
                try JSONSerialization.data(withJSONObject: [
                    "version": serverState.version,
                    "device_id": "ios-1",
                    "notice": "",
                    "items": serverState.items,
                ])
            }
            return StubURLProtocol.Stub(statusCode: 200, headers: [:], body: data)
        }

        let bare = try makeService(store: InMemoryQueueStore())
        defer { bare.shutdown() }
        let localEpisode = PlaybackService.Item(
            trackID: "podcast_ep_local", title: "Local", artist: "Show",
            streamPath: "api/v1/podcasts/episodes/local/stream"
        )
        #expect(bare.enqueue(items: [localEpisode], next: true))
        #expect(bare.items.map(\.trackID) == ["podcast_ep_local"])
        #expect(bare.player.rate == 0)
        #expect(!bare.isPlaying)

        let client = WildstringClient(
            server: try ServerAddress(input: "music.example.com"),
            store: InMemorySessionStore(),
            configuration: StubURLProtocol.configuration()
        )
        let cloud = PodcastCloudQueue(client: client, deviceID: "ios-1")
        let service = try makeService(store: InMemoryQueueStore())
        defer { service.shutdown() }
        service.podcastCloud = cloud
        let first = PlaybackService.Item(
            trackID: "podcast_ep_ep1", title: "One", artist: "Show",
            streamPath: "api/v1/podcasts/episodes/ep1/stream"
        )
        let second = PlaybackService.Item(
            trackID: "podcast_ep_ep2", title: "Two", artist: "Show",
            streamPath: "api/v1/podcasts/episodes/ep2/stream"
        )
        #expect(service.enqueue(items: [first], next: true))
        await cloud.retrySync()
        #expect(service.currentItem == nil)
        #expect(service.items.isEmpty)
        #expect(!service.isPlaying)
        #expect(cloud.items.map(\.episodeId) == ["ep1"])

        #expect(service.enqueue(items: [second], next: true))
        await cloud.retrySync()
        #expect(cloud.items.map(\.episodeId) == ["ep2", "ep1"])
        #expect(service.currentItem == nil)

        service.playPodcastEpisode(first)
        await service.waitForPodcastTasks()
        await cloud.retrySync()
        #expect(service.currentItem?.trackID == "podcast_ep_ep1")
        #expect(service.podcastLine == .show)
        #expect(cloud.items.map(\.episodeId) == ["ep2", "ep1"])

        #expect(service.enqueue(items: [first], next: true))
        await cloud.retrySync()
        #expect(cloud.items.map(\.episodeId) == ["ep2", "ep1"])
    }
}
