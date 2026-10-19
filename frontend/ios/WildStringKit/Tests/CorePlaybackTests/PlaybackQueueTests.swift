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
}
