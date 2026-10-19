import Foundation
import SwiftData

@Model
final class StoredQueueEntry {
    var order: Int
    var entryID: UUID
    var trackID: String
    var title: String
    var artist: String
    var streamPath: String

    init(order: Int, entryID: UUID, trackID: String, title: String, artist: String, streamPath: String) {
        self.order = order
        self.entryID = entryID
        self.trackID = trackID
        self.title = title
        self.artist = artist
        self.streamPath = streamPath
    }
}

@Model
final class StoredQueueState {
    var currentIndex: Int
    var position: Double

    init(currentIndex: Int, position: Double) {
        self.currentIndex = currentIndex
        self.position = position
    }
}

/// SwiftData-backed queue and restore-point store (queue order, entry IDs, position).
public struct SwiftDataQueueStore: QueueStore, @unchecked Sendable {
    private let container: ModelContainer

    public init(container: ModelContainer) {
        self.container = container
    }

    /// Default on-disk store for the app.
    public static func makeDefault() throws -> SwiftDataQueueStore {
        let container = try ModelContainer(for: StoredQueueEntry.self, StoredQueueState.self)
        return SwiftDataQueueStore(container: container)
    }

    /// Disposable in-memory container for tests and previews.
    public static func inMemoryContainer() throws -> ModelContainer {
        try ModelContainer(
            for: StoredQueueEntry.self, StoredQueueState.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
    }

    public static func inMemory() throws -> SwiftDataQueueStore {
        SwiftDataQueueStore(container: try inMemoryContainer())
    }

    public func load() async throws -> PersistedQueue? {
        let context = ModelContext(container)
        let entries = try context.fetch(
            FetchDescriptor<StoredQueueEntry>(sortBy: [SortDescriptor(\StoredQueueEntry.order)])
        )
        guard !entries.isEmpty else { return nil }
        let state = try context.fetch(FetchDescriptor<StoredQueueState>()).first
        return PersistedQueue(
            items: entries.map {
                PlaybackService.Item(
                    id: $0.entryID,
                    trackID: $0.trackID,
                    title: $0.title,
                    artist: $0.artist,
                    streamPath: $0.streamPath
                )
            },
            currentIndex: state.flatMap { $0.currentIndex >= 0 ? $0.currentIndex : nil },
            position: state?.position ?? 0
        )
    }

    public func saveQueue(_ items: [PlaybackService.Item], currentIndex: Int?) async throws {
        let context = ModelContext(container)
        try context.delete(model: StoredQueueEntry.self)
        try context.delete(model: StoredQueueState.self)
        for (index, item) in items.enumerated() {
            context.insert(
                StoredQueueEntry(
                    order: index,
                    entryID: item.id,
                    trackID: item.trackID,
                    title: item.title,
                    artist: item.artist,
                    streamPath: item.streamPath
                )
            )
        }
        context.insert(StoredQueueState(currentIndex: currentIndex ?? -1, position: 0))
        try context.save()
    }

    public func saveProgress(_ progress: QueueProgress) async throws {
        let context = ModelContext(container)
        if let state = try context.fetch(FetchDescriptor<StoredQueueState>()).first {
            state.currentIndex = progress.index ?? -1
            state.position = progress.position
        } else {
            context.insert(
                StoredQueueState(
                    currentIndex: progress.index ?? -1,
                    position: progress.position
                )
            )
        }
        try context.save()
    }

    public func clear() async throws {
        let context = ModelContext(container)
        try context.delete(model: StoredQueueEntry.self)
        try context.delete(model: StoredQueueState.self)
        try context.save()
    }
}
