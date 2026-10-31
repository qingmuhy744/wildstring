import Foundation

/// Queue state for the player: entry order, repeat and shuffle. Entry IDs stay
/// distinct even for the same track, so duplicates keep their own place.
public struct PlaybackQueue: Equatable, Sendable {
    public enum RepeatMode: String, Sendable, CaseIterable {
        case off
        case all
        case one
    }

    public private(set) var items: [PlaybackService.Item]
    public private(set) var currentIndex: Int?
    public private(set) var repeatMode: RepeatMode = .off
    public private(set) var isShuffled = false

    /// Playback order of entry indices; identity order unless shuffled.
    private var order: [Int] = []
    private var positionInOrder = 0

    public init(items: [PlaybackService.Item] = [], currentIndex: Int? = nil) {
        self.items = items
        guard !items.isEmpty else {
            self.currentIndex = nil
            return
        }
        let index = min(max(0, currentIndex ?? 0), items.count - 1)
        self.currentIndex = index
        self.order = Array(items.indices)
        self.positionInOrder = index
    }

    public var count: Int { items.count }
    public var playbackItems: [PlaybackService.Item] { order.map { items[$0] } }

    public var current: PlaybackService.Item? {
        guard let currentIndex, items.indices.contains(currentIndex) else { return nil }
        return items[currentIndex]
    }

    public mutating func set(items: [PlaybackService.Item], startingAt index: Int) {
        self.items = items
        guard !items.isEmpty else {
            currentIndex = nil
            order = []
            positionInOrder = 0
            return
        }
        let start = min(max(0, index), items.count - 1)
        currentIndex = start
        if isShuffled {
            var rest = Array(items.indices).filter { $0 != start }
            rest.shuffle()
            order = [start] + rest
            positionInOrder = 0
        } else {
            order = Array(items.indices)
            positionInOrder = start
        }
    }

    /// Next entry in playback order; wraps only with repeat all.
    @discardableResult
    public mutating func advance() -> PlaybackService.Item? {
        guard !items.isEmpty, !order.isEmpty else { return nil }
        if positionInOrder + 1 < order.count {
            positionInOrder += 1
        } else if repeatMode == .all {
            positionInOrder = 0
        } else {
            return nil
        }
        currentIndex = order[positionInOrder]
        return current
    }

    @discardableResult
    public mutating func rewind() -> PlaybackService.Item? {
        guard !items.isEmpty, positionInOrder > 0 else { return nil }
        positionInOrder -= 1
        currentIndex = order[positionInOrder]
        return current
    }

    public mutating func move(to index: Int) {
        guard items.indices.contains(index) else { return }
        currentIndex = index
        if let position = order.firstIndex(of: index) {
            positionInOrder = position
        }
    }

    public mutating func setRepeatMode(_ mode: RepeatMode) {
        repeatMode = mode
    }

    public mutating func cycleRepeatMode() {
        switch repeatMode {
        case .off: repeatMode = .all
        case .all: repeatMode = .one
        case .one: repeatMode = .off
        }
    }

    public mutating func toggleShuffle() {
        isShuffled.toggle()
        rebuildOrder(keeping: current?.id)
    }

    /// Inserts without changing the current entry or the existing shuffle order.
    public mutating func enqueue(_ entries: [PlaybackService.Item], next: Bool = false) {
        guard !entries.isEmpty else { return }
        guard let currentIndex else {
            set(items: entries, startingAt: 0)
            return
        }
        let insertion = next ? currentIndex + 1 : items.count
        items.insert(contentsOf: entries, at: insertion)
        order = order.map { $0 >= insertion ? $0 + entries.count : $0 }
        let added = Array(insertion..<(insertion + entries.count))
        order.insert(contentsOf: added, at: next ? positionInOrder + 1 : order.count)
    }

    /// Removes an entry; play continues with the remaining entries.
    public mutating func remove(at index: Int) {
        guard items.indices.contains(index) else { return }
        let currentEntryID = current?.id
        let oldPosition = positionInOrder
        items.remove(at: index)
        order = order.filter { $0 != index }.map { $0 > index ? $0 - 1 : $0 }
        guard !order.isEmpty else {
            currentIndex = nil
            positionInOrder = 0
            return
        }
        if let retained = items.firstIndex(where: { $0.id == currentEntryID }),
           let position = order.firstIndex(of: retained) {
            currentIndex = retained
            positionInOrder = position
        } else {
            positionInOrder = min(oldPosition, order.count - 1)
            currentIndex = order[positionInOrder]
        }
    }

    /// Reorders the actual listening order, including an already shuffled queue.
    /// The current entry remains loaded; the rest of the order is not reshuffled.
    public mutating func movePlaybackEntries(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        let currentEntryID = current?.id
        var listeningOrder = playbackItems
        let moving = offsets.sorted().map { listeningOrder[$0] }
        let insertAt = destination - offsets.filter { $0 < destination }.count
        for index in offsets.sorted(by: >) { listeningOrder.remove(at: index) }
        listeningOrder.insert(contentsOf: moving, at: insertAt)
        items = listeningOrder
        order = Array(items.indices)
        currentIndex = items.firstIndex { $0.id == currentEntryID }
        positionInOrder = currentIndex ?? 0
    }

    public mutating func moveEntries(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        let currentEntryID = current?.id
        let moving = offsets.sorted().map { items[$0] }
        let removedBeforeDestination = offsets.filter { $0 < destination }.count
        let insertAt = max(0, min(destination - removedBeforeDestination, items.count - moving.count))
        var remaining = items
        for index in offsets.sorted(by: >) {
            remaining.remove(at: index)
        }
        remaining.insert(contentsOf: moving, at: insertAt)
        items = remaining
        rebuildOrder(keeping: currentEntryID)
    }

    private mutating func rebuildOrder(keeping entryID: UUID?) {
        guard !items.isEmpty else {
            currentIndex = nil
            order = []
            positionInOrder = 0
            return
        }
        let index = entryID.flatMap { id in items.firstIndex(where: { $0.id == id }) }
        currentIndex = index ?? min(currentIndex ?? 0, items.count - 1)
        guard let currentIndex else { return }
        if isShuffled {
            var rest = Array(items.indices).filter { $0 != currentIndex }
            rest.shuffle()
            order = [currentIndex] + rest
            positionInOrder = 0
        } else {
            order = Array(items.indices)
            positionInOrder = currentIndex
        }
    }
}
