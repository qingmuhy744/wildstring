import Foundation
import Testing
@testable import CorePlayback

private func item(_ suffix: String) -> PlaybackService.Item {
    PlaybackService.Item(
        trackID: "t\(suffix)",
        title: "Title \(suffix)",
        artist: "Artist",
        streamPath: "api/v1/tracks/t\(suffix)/stream"
    )
}

@Suite("PlaybackQueue")
struct PlaybackQueueTests {
    @Test func setStartsAtRequestedIndex() {
        var queue = PlaybackQueue()
        queue.set(items: [item("a"), item("b"), item("c")], startingAt: 1)
        #expect(queue.currentIndex == 1)
        #expect(queue.current?.trackID == "tb")
    }

    @Test func setClampsOutOfRangeIndex() {
        var queue = PlaybackQueue()
        queue.set(items: [item("a")], startingAt: 5)
        #expect(queue.currentIndex == 0)
        queue.set(items: [], startingAt: 0)
        #expect(queue.currentIndex == nil)
        #expect(queue.current == nil)
    }

    @Test func advanceStopsAtEnd() {
        var queue = PlaybackQueue()
        queue.set(items: [item("a"), item("b")], startingAt: 0)
        #expect(queue.advance()?.trackID == "tb")
        #expect(queue.advance() == nil)
        #expect(queue.currentIndex == 1)
    }

    @Test func rewindStopsAtStart() {
        var queue = PlaybackQueue()
        queue.set(items: [item("a"), item("b")], startingAt: 1)
        #expect(queue.rewind()?.trackID == "ta")
        #expect(queue.rewind() == nil)
        #expect(queue.currentIndex == 0)
    }

    @Test func moveKeepsDuplicatesDistinct() {
        var queue = PlaybackQueue()
        let first = item("a")
        let second = item("a")
        #expect(first.id != second.id)
        queue.set(items: [first, second], startingAt: 0)
        queue.move(to: 1)
        #expect(queue.current?.id == second.id)
        #expect(queue.current?.trackID == "ta")
    }

    @Test func repeatAllWrapsAtEnd() {
        var queue = PlaybackQueue()
        queue.set(items: [item("a"), item("b")], startingAt: 1)
        queue.setRepeatMode(.all)
        #expect(queue.advance()?.trackID == "ta")
        #expect(queue.currentIndex == 0)
    }

    @Test func repeatOneIsExposedForTrackEnd() {
        var queue = PlaybackQueue()
        queue.set(items: [item("a")], startingAt: 0)
        queue.cycleRepeatMode()
        queue.cycleRepeatMode()
        #expect(queue.repeatMode == .one)
        // Track-end restart for repeat one is handled by the playback service.
        #expect(queue.advance() == nil)
    }

    @Test func shuffleStartsAtCurrentAndCoversEveryEntryOnce() {
        var queue = PlaybackQueue()
        queue.set(items: (0..<6).map { item("\($0)") }, startingAt: 2)
        queue.toggleShuffle()
        #expect(queue.isShuffled)
        #expect(queue.currentIndex == 2)
        let current = queue.current
        var visited: Set<UUID> = [current?.id ?? UUID()]
        while let next = queue.advance() {
            visited.insert(next.id)
        }
        #expect(visited.count == 6)
    }

    @Test func togglingShuffleOnAndOffKeepsCurrent() {
        var queue = PlaybackQueue()
        queue.set(items: (0..<6).map { item("\($0)") }, startingAt: 3)
        queue.toggleShuffle()
        #expect(queue.isShuffled)
        #expect(queue.current?.trackID == "t3")
        queue.toggleShuffle()
        #expect(!queue.isShuffled)
        #expect(queue.advance()?.trackID == "t4")
    }

    @Test func removingEntriesKeepsTheOthersConsistent() {
        var queue = PlaybackQueue()
        let a = item("a")
        let b = item("b")
        let c = item("c")
        queue.set(items: [a, b, c], startingAt: 2)
        queue.remove(at: 0)
        #expect(queue.count == 2)
        #expect(queue.current?.id == c.id)
        #expect(queue.currentIndex == 1)
        queue.remove(at: 1)
        #expect(queue.count == 1)
        #expect(queue.current?.id == b.id)
    }

    @Test func movingEntriesKeepsTheCurrentEntry() {
        var queue = PlaybackQueue()
        let a = item("a")
        let b = item("b")
        let c = item("c")
        queue.set(items: [a, b, c], startingAt: 0)
        queue.moveEntries(fromOffsets: IndexSet(integer: 2), toOffset: 0)
        #expect(queue.items.map(\.trackID) == ["tc", "ta", "tb"])
        #expect(queue.current?.id == a.id)
        #expect(queue.currentIndex == 1)
    }
}
