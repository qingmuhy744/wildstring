import Foundation
import Testing
@testable import CorePlayback

private func ep(_ id: String, _ index: Int, _ completed: Bool = false) -> PodcastContinuation.Episode {
    PodcastContinuation.Episode(
        id: id,
        title: "Episode \(id)",
        chronologicalIndex: index,
        isCompleted: completed
    )
}

/// Shared vectors: `episodes` is supplied newest-first (how the API returns a
/// show), with chronologicalIndex 0 = oldest, so "1" is the oldest episode.
@Suite("PodcastContinuation")
struct PodcastContinuationTests {
    private var episodes: [PodcastContinuation.Episode] {
        [ep("5", 4), ep("4", 3), ep("3", 2), ep("2", 1), ep("1", 0)]
    }

    @Test func followUsesSuppliedOrder() {
        let scrambled = [ep("1", 0), ep("4", 3), ep("2", 1)]
        let next = PodcastContinuation.nextEpisode(
            currentID: "1", episodes: scrambled, preference: .init(order: .follow)
        )
        #expect(next?.id == "4")
    }

    @Test func skipsCompletedByDefault() {
        var eps = episodes
        eps[2] = ep("3", 2, true) // "3" already listened
        let next = PodcastContinuation.nextEpisode(
            currentID: "4", episodes: eps, preference: .init()
        )
        #expect(next?.id == "2")
    }

    @Test func keepsCompletedWhenSkipDisabled() {
        var eps = episodes
        eps[2] = ep("3", 2, true)
        let next = PodcastContinuation.nextEpisode(
            currentID: "4", episodes: eps, preference: .init(skipCompleted: false)
        )
        #expect(next?.id == "3")
    }

    @Test func oldestFirstPlaysOldestToNewest() {
        let scrambled = [ep("3", 2), ep("1", 0), ep("5", 4), ep("2", 1), ep("4", 3)]
        let next = PodcastContinuation.nextEpisode(
            currentID: "2", episodes: scrambled, preference: .init(order: .oldestFirst)
        )
        #expect(next?.id == "3") // 1, 2, 3, 4, 5
    }

    @Test func newestFirstPlaysNewestToOldest() {
        let scrambled = [ep("3", 2), ep("1", 0), ep("5", 4), ep("2", 1), ep("4", 3)]
        let next = PodcastContinuation.nextEpisode(
            currentID: "4", episodes: scrambled, preference: .init(order: .newestFirst)
        )
        #expect(next?.id == "3") // 5, 4, 3, 2, 1
    }

    @Test func disabledStopsAutoContinue() {
        let next = PodcastContinuation.nextEpisode(
            currentID: "4", episodes: episodes, preference: .init(autoContinue: false)
        )
        #expect(next == nil)
    }

    @Test func currentNotInShowStops() {
        // 以当前集所属节目为边界，不跨节目合并.
        let next = PodcastContinuation.nextEpisode(
            currentID: "other-show", episodes: episodes, preference: .init()
        )
        #expect(next == nil)
    }

    @Test func lastEpisodeStops() {
        let next = PodcastContinuation.nextEpisode(
            currentID: "1", episodes: episodes, preference: .init()
        )
        #expect(next == nil)
    }

    @Test func allRemainingCompletedStops() {
        let eps = [ep("3", 2), ep("2", 1, true), ep("1", 0, true)]
        let next = PodcastContinuation.nextEpisode(
            currentID: "3", episodes: eps, preference: .init()
        )
        #expect(next == nil)
    }

    @Test func previousIsImmediateAndIgnoresAutoContinue() {
        let prev = PodcastContinuation.previousEpisode(
            currentID: "3", episodes: episodes, preference: .init(autoContinue: false)
        )
        #expect(prev?.id == "4")
        #expect(PodcastContinuation.previousEpisode(
            currentID: "5", episodes: episodes, preference: .init()
        ) == nil)
    }
}
