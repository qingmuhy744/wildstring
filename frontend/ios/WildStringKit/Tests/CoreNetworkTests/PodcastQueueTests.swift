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
        #expect(queue.items[0].origin == "manual")

        let prefs = try JSONDecoder().decode(
            PodcastQueuePreferences.self,
            from: Data(#"{}"#.utf8)
        )
        #expect(prefs.defaultAction == "inbox")
        #expect(prefs.autoLimit == 3)
        #expect(prefs.shows.isEmpty)

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

    @Test func playingInsertsOnlyTheChosenEpisode() {
        let queue = [
            PodcastQueueItem(episodeId: "b", origin: "rule"),
            PodcastQueueItem(episodeId: "c", origin: "manual"),
        ]
        let next = PodcastQueueMerge.playing("a", queue: queue)
        #expect(next.map(\.episodeId) == ["a", "b", "c"])
        #expect(next.map(\.origin) == ["manual", "rule", "manual"])
        let again = PodcastQueueMerge.playing("c", queue: next)
        #expect(again.map(\.episodeId) == ["c", "a", "b"])
        #expect(again[0].origin == "manual")
        #expect(!again.contains { $0.episodeId == "show-rest" })
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
}
