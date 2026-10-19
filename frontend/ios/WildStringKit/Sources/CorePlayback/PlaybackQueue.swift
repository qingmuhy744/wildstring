import Foundation

/// Queue position state for the player. Entry IDs stay distinct even for the
/// same track, so duplicates keep their own place in the queue.
public struct PlaybackQueue: Equatable, Sendable {
    public private(set) var items: [PlaybackService.Item]
    public private(set) var currentIndex: Int?

    public init(items: [PlaybackService.Item] = [], currentIndex: Int? = nil) {
        self.items = items
        self.currentIndex = currentIndex
    }

    public var current: PlaybackService.Item? {
        guard let currentIndex, items.indices.contains(currentIndex) else { return nil }
        return items[currentIndex]
    }

    public mutating func set(items: [PlaybackService.Item], startingAt index: Int) {
        self.items = items
        currentIndex = items.isEmpty ? nil : min(max(0, index), items.count - 1)
    }

    @discardableResult
    public mutating func advance() -> PlaybackService.Item? {
        guard let currentIndex, currentIndex + 1 < items.count else { return nil }
        self.currentIndex = currentIndex + 1
        return current
    }

    @discardableResult
    public mutating func rewind() -> PlaybackService.Item? {
        guard let currentIndex, currentIndex > 0 else { return nil }
        self.currentIndex = currentIndex - 1
        return current
    }

    public mutating func move(to index: Int) {
        guard items.indices.contains(index) else { return }
        currentIndex = index
    }
}
