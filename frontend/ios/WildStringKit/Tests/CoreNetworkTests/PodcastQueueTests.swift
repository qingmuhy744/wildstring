import Foundation
import Testing
@testable import CoreNetwork

@Suite("PodcastQueue")
struct PodcastQueueTests {
    @Test func conflictDecodesCurrentWithoutReplacingTheCaller() throws {
        let data = Data(
            #"{"detail":{"code":"podcast_queue_conflict","current":{"version":4,"items":[{"episode_id":"e1","origin":"rule"}]}}}"#
                .utf8
        )
        let conflict = try #require(PodcastQueueConflict.decode(from: data))
        #expect(conflict.current.version == 4)
        #expect(conflict.current.deviceId == "")
        #expect(conflict.current.notice == "")
        #expect(conflict.current.items == [PodcastQueueItem(episodeId: "e1", origin: "rule")])
        let other = Data(#"{"detail":"episode_unavailable"}"#.utf8)
        #expect(PodcastQueueConflict.decode(from: other) == nil)
    }

    @Test func queueAndPreferencePayloadsUseTheServerShape() throws {
        let queue = try JSONDecoder().decode(
            PodcastQueueState.self,
            from: Data(#"{"version":2,"items":[{"episode_id":"a","origin":"manual"}]}"#.utf8)
        )
        #expect(queue.version == 2)
        #expect(queue.deviceId == "")
        #expect(queue.notice == "")
        #expect(queue.items[0].origin == "manual")

        let full = try JSONDecoder().decode(
            PodcastQueueState.self,
            from: Data(#"{"version":3,"items":[],"notice":"queue_full"}"#.utf8)
        )
        #expect(full.notice == "queue_full")
        let cleared = try JSONDecoder().decode(
            PodcastQueueState.self,
            from: Data(#"{"version":3,"items":[],"notice":""}"#.utf8)
        )
        #expect(cleared.notice == "")

        let prefs = try JSONDecoder().decode(
            PodcastQueuePreferences.self,
            from: Data(#"{}"#.utf8)
        )
        #expect(prefs.defaultAction == "queue_last")
        #expect(prefs.autoLimit == 3)
        #expect(prefs.autoContinue == true)
        #expect(prefs.shows.isEmpty)

        let disabledPrefs = try JSONDecoder().decode(
            PodcastQueuePreferences.self,
            from: Data(#"{"default_action":"queue_last","auto_limit":5,"auto_continue":false,"shows":{}}"#.utf8)
        )
        #expect(disabledPrefs.defaultAction == "queue_last")
        #expect(disabledPrefs.autoLimit == 5)
        #expect(disabledPrefs.autoContinue == false)
        let encodedPrefs = try JSONEncoder().encode(disabledPrefs)
        let prefsJSON = try #require(try JSONSerialization.jsonObject(with: encodedPrefs) as? [String: Any])
        #expect(prefsJSON["auto_continue"] as? Bool == false)

        let encoded = try JSONEncoder().encode(
            PodcastQueueUpdate(
                version: 2,
                deviceId: "mac",
                items: [PodcastQueueItem(episodeId: "a", origin: "manual")]
            )
        )
        let json = try #require(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(json["device_id"] as? String == "mac")
        #expect(json["version"] as? Int == 2)
    }

    @Test func playNextSkipsTheCurrentEpisodeAndOtherwiseInserts() {
        let queue = [
            PodcastQueueItem(episodeId: "now", origin: "manual"),
            PodcastQueueItem(episodeId: "later", origin: "rule"),
        ]
        let skipped = PodcastQueueMerge.enqueue("now", queue: queue, next: true, after: "now")
        #expect(skipped == queue)

        let afterCurrent = PodcastQueueMerge.enqueue("extra", queue: queue, next: true, after: "now")
        #expect(afterCurrent.map(\.episodeId) == ["now", "extra", "later"])
        #expect(afterCurrent[1].origin == "manual")
        #expect(afterCurrent[2].origin == "rule")

        let missingCurrent = PodcastQueueMerge.enqueue("extra", queue: queue, next: true, after: "elsewhere")
        #expect(missingCurrent.map(\.episodeId) == ["extra", "now", "later"])
        let emptyPlayer = PodcastQueueMerge.enqueue("extra", queue: queue, next: true, after: nil)
        #expect(emptyPlayer.map(\.episodeId) == ["extra", "now", "later"])

        let appended = PodcastQueueMerge.enqueue("playing", queue: queue, next: false, after: "playing")
        #expect(appended.map(\.episodeId) == ["now", "later", "playing"])
        let already = PodcastQueueMerge.enqueue("later", queue: queue, next: false, after: nil)
        #expect(already.map(\.episodeId) == ["now", "later"])
        #expect(already[1].origin == "rule")
    }

    @Test func finishedEpisodeLeavesAndAutoContinueIsNotInserted() {
        let queue = [
            PodcastQueueItem(episodeId: "a", origin: "manual"),
            PodcastQueueItem(episodeId: "b", origin: "rule"),
        ]
        let after = PodcastQueueMerge.finished("a", queue: queue)
        #expect(after.map(\.episodeId) == ["b"])
        #expect(after[0].origin == "rule")
        let untouched = PodcastQueueMerge.finished("preview", queue: after)
        #expect(untouched == after)
    }

    @Test func enqueueKeepsTheRestAndMovingARuleBecomesManual() {
        let queue = [
            PodcastQueueItem(episodeId: "now", origin: "manual"),
            PodcastQueueItem(episodeId: "later", origin: "rule"),
        ]
        let appended = PodcastQueueMerge.enqueue("extra", queue: queue, next: false, after: "now")
        #expect(appended.map(\.episodeId) == ["now", "later", "extra"])
        let next = PodcastQueueMerge.enqueue("extra", queue: queue, next: true, after: "now")
        #expect(next.map(\.episodeId) == ["now", "extra", "later"])
        #expect(next[1].origin == "manual")
        #expect(next[2].origin == "rule")
        let moved = PodcastQueueMerge.moving(queue, from: IndexSet(integer: 1), to: 0)
        #expect(moved.map(\.episodeId) == ["later", "now"])
        #expect(moved[0].origin == "manual")
        #expect(moved[1].origin == "manual")
    }

    @Test func deviceIDPrefersPlaybackIDAndOtherwisePersists() throws {
        let suite = "wildstring.device-id.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        #expect(WildstringDeviceID.resolve(preferred: "mac-1", defaults: defaults) == "mac-1")
        #expect(defaults.string(forKey: WildstringDeviceID.storageKey) == nil)
        let created = WildstringDeviceID.resolve(preferred: "  ", defaults: defaults)
        #expect(!created.isEmpty)
        #expect(WildstringDeviceID.resolve(preferred: "", defaults: defaults) == created)
        #expect(defaults.string(forKey: WildstringDeviceID.storageKey) == created)
    }

    @Test func deliveryActionNormalization() {
        #expect(normalizeDeliveryAction(nil) == "queue_last")
        #expect(normalizeDeliveryAction("") == "queue_last")
        #expect(normalizeDeliveryAction("inbox") == "queue_last")
        #expect(normalizeDeliveryAction("ignore") == "ignore")
        #expect(normalizeDeliveryAction("queue_last") == "queue_last")
        #expect(normalizeDeliveryAction("queue_next") == "queue_next")
        #expect(normalizeDeliveryAction("invalid_action") == "queue_last")
    }

    @Test func removingFromQueue() {
        let queue = [
            PodcastQueueItem(episodeId: "a", origin: "manual"),
            PodcastQueueItem(episodeId: "b", origin: "rule"),
            PodcastQueueItem(episodeId: "c", origin: "manual"),
        ]
        let after = PodcastQueueMerge.removing("b", queue: queue)
        #expect(after.map(\.episodeId) == ["a", "c"])
        let nonExistent = PodcastQueueMerge.removing("z", queue: after)
        #expect(nonExistent.map(\.episodeId) == ["a", "c"])
    }

    @Test func podcastEpisodeDecodesCompletedAndLoved() throws {
        let json = """
        {
            "id": "ep-1",
            "podcast_id": "pod-1",
            "title": "Episode 1",
            "completed": true,
            "loved": true
        }
        """
        let ep = try JSONDecoder().decode(PodcastEpisode.self, from: Data(json.utf8))
        #expect(ep.completed == true)
        #expect(ep.loved == true)

        let fallbackJson = """
        {
            "id": "ep-2",
            "podcast_id": "pod-1",
            "title": "Episode 2",
            "completed": false,
            "favorite": true
        }
        """
        let ep2 = try JSONDecoder().decode(PodcastEpisode.self, from: Data(fallbackJson.utf8))
        #expect(ep2.completed == false)
        #expect(ep2.loved == true)

        let defaultJson = """
        {
            "id": "ep-3",
            "podcast_id": "pod-1",
            "title": "Episode 3"
        }
        """
        let ep3 = try JSONDecoder().decode(PodcastEpisode.self, from: Data(defaultJson.utf8))
        #expect(ep3.completed == false)
        #expect(ep3.loved == false)
    }

    @Test func podcastDiscoveryCacheHonorsTTL() async throws {
        let cache = PodcastDiscoveryCache(ttl: 0.1)
        let page = PodcastDirectoryPage(results: [], regions: ["us", "cn"], explicitHidden: 0, failedRegions: [])
        cache.set(region: "cn", page: page)
        #expect(cache.get(region: "cn") != nil)
        #expect(cache.get(region: "us") == nil)

        try await Task.sleep(nanoseconds: 150_000_000)
        #expect(cache.get(region: "cn") == nil)

        cache.set(region: "us", page: page)
        cache.clear()
        #expect(cache.get(region: "us") == nil)
    }
}
