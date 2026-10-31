import Testing
@testable import CorePlayback

@Suite("Listening clock and tracker")
struct ListeningTrackerTests {
    @Test func countsAdvancementButNotPauseOrSeek() {
        var clock = ListeningClock()
        clock.reset(now: 0, mediaPosition: 0, playing: true)
        #expect(clock.sample(now: 5_000, mediaPosition: 3_000, playing: true) == 3_000)
        #expect(clock.sample(now: 10_000, mediaPosition: 3_000, playing: false) == 3_000)
        #expect(clock.sample(now: 20_000, mediaPosition: 3_000, playing: false) == 3_000)
        clock.reanchor(now: 20_000, mediaPosition: 90_000, playing: true)
        #expect(clock.sample(now: 21_000, mediaPosition: 91_000, playing: true) == 4_000)
    }

    @Test func capsReportedAdvancementByMonotonicTime() {
        var clock = ListeningClock()
        clock.reset(now: 100, mediaPosition: 100, playing: true)
        #expect(clock.sample(now: 600, mediaPosition: 10_000, playing: true) == 500)
        #expect(clock.sample(now: 700, mediaPosition: 0, playing: true) == 500)
    }

    @Test func reportsCumulativeMusicAndSkipsPodcasts() {
        var tracker = ListeningTracker()
        let started = tracker.begin(
            trackID: "track-1",
            nowMs: 0,
            positionMs: 0,
            playing: true,
            startedAt: 1_700_000_000
        )
        #expect(started == nil)
        #expect(
            tracker.sample(nowMs: 4_000, positionMs: 4_000, playing: true, state: "playing") == nil
        )
        let first = tracker.sample(nowMs: 5_200, positionMs: 5_200, playing: true, state: "playing")
        #expect(first?.listenedMs == 5_200)
        #expect(first?.trackId == "track-1")
        #expect(first?.state == "playing")
        let paused = tracker.flush(state: "paused", nowMs: 6_000, positionMs: 6_000)
        #expect(paused?.listenedMs == 6_000)
        #expect(paused?.sessionId == first?.sessionId)
        tracker.reject(sessionId: paused?.sessionId ?? "")
        let retried = tracker.flush(state: "paused", nowMs: 6_000, positionMs: 6_000)
        #expect(retried?.sessionId == first?.sessionId)
        #expect(retried?.listenedMs == 6_000)

        let ended = tracker.begin(
            trackID: "podcast_ep_one",
            nowMs: 7_000,
            positionMs: 0,
            playing: true,
            startedAt: 1_700_000_100
        )
        #expect(ended == nil)
        #expect(
            tracker.sample(nowMs: 20_000, positionMs: 10_000, playing: true, state: "playing")
                == nil
        )
    }
}

@Suite("Podcast bookmark")
struct PodcastBookmarkTests {
    @Test func sequenceIncreasesAndConflictStopsUploads() {
        var bookmark = PodcastBookmark()
        bookmark.begin(episodeId: "ep", deviceId: "phone", baseVersion: 4)
        let play = bookmark.next(
            positionSeconds: 1,
            durationSeconds: 100,
            event: "play",
            nowMs: 0,
            force: true
        )
        #expect(play?.sequence == 1)
        #expect(play?.baseVersion == 4)
        #expect(
            bookmark.next(
                positionSeconds: 2,
                durationSeconds: 100,
                event: "progress",
                nowMs: 1_000,
                force: false
            ) == nil
        )
        let later = bookmark.next(
            positionSeconds: 12,
            durationSeconds: 100,
            event: "progress",
            nowMs: 11_000,
            force: false
        )
        #expect(later?.sequence == 2)
        #expect(later?.sessionId == play?.sessionId)
        bookmark.block()
        #expect(
            bookmark.next(
                positionSeconds: 20,
                durationSeconds: 100,
                event: "pause",
                nowMs: 30_000,
                force: true
            ) == nil
        )
    }
}
