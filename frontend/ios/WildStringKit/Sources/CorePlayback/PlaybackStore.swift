import Foundation

public struct QueueProgress: Equatable, Sendable {
    public var index: Int?
    public var position: Double

    public init(index: Int?, position: Double) {
        self.index = index
        self.position = position
    }
}

public struct PersistedQueue: Equatable, Sendable {
    public var items: [PlaybackService.Item]
    public var currentIndex: Int?
    public var position: Double

    public init(items: [PlaybackService.Item], currentIndex: Int?, position: Double) {
        self.items = items
        self.currentIndex = currentIndex
        self.position = position
    }
}

public protocol QueueStore: Sendable {
    func load() async throws -> PersistedQueue?
    func saveQueue(_ items: [PlaybackService.Item], currentIndex: Int?) async throws
    func saveProgress(_ progress: QueueProgress) async throws
    func clear() async throws
    /// A store bound to one connection space (server), or self when unscoped.
    func scoped(to space: String) -> any QueueStore
}

extension QueueStore {
    public func scoped(to space: String) -> any QueueStore { self }
}

/// In-memory queue store for tests and previews.
public actor InMemoryQueueStore: QueueStore {
    private var persisted: PersistedQueue?

    public init() {}

    public func load() async throws -> PersistedQueue? {
        persisted
    }

    public func saveQueue(_ items: [PlaybackService.Item], currentIndex: Int?) async throws {
        persisted = PersistedQueue(items: items, currentIndex: currentIndex, position: 0)
    }

    public func saveProgress(_ progress: QueueProgress) async throws {
        guard var current = persisted else { return }
        current.currentIndex = progress.index
        current.position = progress.position
        persisted = current
    }

    public func clear() async throws {
        persisted = nil
    }
}
