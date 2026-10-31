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

    @Test func batchNextPreservesCurrentAndVisibleOrderIncludingDuplicates() {
        let a = item("a"), b = item("b"), c = item("c")
        var queue = PlaybackQueue(items: [a, b, c], currentIndex: 1)
        let additions = [item("a"), item("d")]
        queue.enqueue(additions, next: true)
        #expect(queue.current?.id == b.id)
        #expect(queue.items.map(\.trackID) == ["ta", "tb", "ta", "td", "tc"])
        #expect(queue.advance()?.id == additions[0].id)
        #expect(queue.advance()?.id == additions[1].id)
        #expect(queue.advance()?.id == c.id)
    }

    @Test func nextInShuffleKeepsPendingOrderAndDoesNotReplayHistory() {
        var queue = PlaybackQueue(items: (0..<5).map { item("\($0)") }, currentIndex: 2)
        queue.toggleShuffle()
        _ = queue.advance()
        let current = queue.current
        var baseline = queue
        var remainder: [UUID] = []
        while let value = baseline.advance() { remainder.append(value.id) }
        let additions = [item("x"), item("y")]
        queue.enqueue(additions, next: true)
        #expect(queue.current?.id == current?.id)
        #expect(queue.isShuffled)
        var actual: [UUID] = []
        while let value = queue.advance() { actual.append(value.id) }
        #expect(actual == additions.map(\.id) + remainder)
    }

    @Test func appendAtEndAndEmptyQueue() {
        var queue = PlaybackQueue()
        queue.enqueue([item("a"), item("b")])
        #expect(queue.current?.trackID == "ta")
        queue.enqueue([item("c"), item("d")])
        #expect(queue.advance()?.trackID == "tb")
        #expect(queue.advance()?.trackID == "tc")
        #expect(queue.advance()?.trackID == "td")
        #expect(queue.advance() == nil)
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

    @Test func removingEarlierEntryPreservesMiddleCurrentAndSuccessor() {
        let entries = (0..<5).map { item("\($0)") }
        var queue = PlaybackQueue(items: entries, currentIndex: 2)
        queue.remove(at: 0)
        #expect(queue.current?.id == entries[2].id)
        #expect(queue.currentIndex == 1)
        #expect(queue.advance()?.id == entries[3].id)
    }

    @Test func removingShuffleHistoryPreservesListeningOrder() throws {
        var queue = PlaybackQueue(items: (0..<6).map { item("\($0)") }, currentIndex: 0)
        queue.toggleShuffle()
        _ = queue.advance()
        _ = queue.advance()
        let before = queue.playbackItems
        let current = queue.current
        let removed = before[0]
        queue.remove(at: try #require(queue.items.firstIndex { $0.id == removed.id }))
        #expect(queue.isShuffled)
        #expect(queue.current?.id == current?.id)
        #expect(queue.playbackItems == before.filter { $0.id != removed.id })
        #expect(queue.advance()?.id == before[3].id)
    }

    @Test func movingBatchIncludingCurrentKeepsDuplicateEntryIdentity() {
        let entries = [item("a"), item("b"), item("a"), item("c"), item("d")]
        var queue = PlaybackQueue(items: entries, currentIndex: 2)
        queue.movePlaybackEntries(fromOffsets: IndexSet([0, 2]), toOffset: 5)
        #expect(queue.playbackItems.map(\.id) == [entries[1], entries[3], entries[4], entries[0], entries[2]].map(\.id))
        #expect(queue.current?.id == entries[2].id)
        #expect(queue.currentIndex == 4)
        #expect(queue.rewind()?.id == entries[0].id)
    }

    @Test func movingShuffledUpcomingEntryDoesNotReshuffleOrReplayHistory() {
        var queue = PlaybackQueue(items: (0..<6).map { item("\($0)") }, currentIndex: 2)
        queue.toggleShuffle()
        _ = queue.advance()
        let before = queue.playbackItems
        let current = queue.current
        queue.movePlaybackEntries(fromOffsets: IndexSet(integer: 5), toOffset: 2)
        #expect(queue.isShuffled)
        #expect(queue.current?.id == current?.id)
        let expected = Array(before.prefix(2)) + [before[5]] + Array(before[2..<5])
        #expect(queue.playbackItems == expected)
        var upcoming: [UUID] = []
        while let entry = queue.advance() { upcoming.append(entry.id) }
        #expect(upcoming == Array(expected.dropFirst(2)).map(\.id))
    }
}
