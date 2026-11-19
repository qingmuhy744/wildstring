import Foundation

public struct QueueProgress: Equatable, Sendable {
    public var index: Int?
    public var position: Double

    public init(index: Int?, position: Double) {
        self.index = index
        self.position = position
    }
}

public struct QueueContinuation: Equatable, Sendable {
    public var scope: String
    public var active: Bool

    public init(scope: String, active: Bool) { self.scope = scope; self.active = active }
}

public struct PersistedQueue: Equatable, Sendable {
    public var items: [PlaybackService.Item]
    public var currentIndex: Int?
    public var position: Double
    public var continuation: QueueContinuation?

    public init(items: [PlaybackService.Item], currentIndex: Int?, position: Double, continuation: QueueContinuation? = nil) {
        self.continuation = continuation
        self.items = items
        self.currentIndex = currentIndex
        self.position = position
    }
}

public protocol QueueStore: Sendable {
    func load() async throws -> PersistedQueue?
    func saveQueue(_ items: [PlaybackService.Item], currentIndex: Int?, continuation: QueueContinuation?) async throws
    func saveProgress(_ progress: QueueProgress) async throws
    func clear() async throws
    /// A store bound to one connection space (server), or self when unscoped.
    func scoped(to space: String) -> any QueueStore
}

extension QueueStore {
    public func saveQueue(_ items: [PlaybackService.Item], currentIndex: Int?) async throws {
        try await saveQueue(items, currentIndex: currentIndex, continuation: nil)
    }

    public func scoped(to space: String) -> any QueueStore { self }
}

/// In-memory queue store for tests and previews.
public actor InMemoryQueueStore: QueueStore {
    private var persisted: PersistedQueue?

    public init() {}

    public func load() async throws -> PersistedQueue? {
        persisted
    }

    public func saveQueue(_ items: [PlaybackService.Item], currentIndex: Int?, continuation: QueueContinuation?) async throws {
        persisted = PersistedQueue(items: items, currentIndex: currentIndex, position: 0, continuation: continuation)
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
