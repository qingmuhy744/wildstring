import Foundation
import SwiftData

@Model
final class StoredQueueEntry {
    var space: String?
    var order: Int
    var entryID: UUID
    var trackID: String
    var title: String
    var artist: String
    var album: String?
    var streamPath: String

    init(
        space: String?,
        order: Int,
        entryID: UUID,
        trackID: String,
        title: String,
        artist: String,
        album: String?,
        streamPath: String
    ) {
        self.space = space
        self.order = order
        self.entryID = entryID
        self.trackID = trackID
        self.title = title
        self.artist = artist
        self.album = album
        self.streamPath = streamPath
    }
}

@Model
final class StoredQueueState {
    var space: String?
    var currentIndex: Int
    var position: Double

    init(space: String?, currentIndex: Int, position: Double) {
        self.space = space
        self.currentIndex = currentIndex
        self.position = position
    }
}

/// SwiftData-backed queue and restore-point store, scoped to one connection
/// space (server) so switching servers keeps independent queues.
public struct SwiftDataQueueStore: QueueStore, @unchecked Sendable {
    private let container: ModelContainer
    private let space: String

    public init(container: ModelContainer, space: String = "default") {
        self.container = container
        self.space = space
    }

    /// Default on-disk store for the app.
    public static func makeDefault(space: String = "default") throws -> SwiftDataQueueStore {
        let container = try ModelContainer(for: StoredQueueEntry.self, StoredQueueState.self)
        return SwiftDataQueueStore(container: container, space: space)
    }

    /// Disposable in-memory container for tests and previews.
    public static func inMemoryContainer() throws -> ModelContainer {
        try ModelContainer(
            for: StoredQueueEntry.self, StoredQueueState.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
    }

    public static func inMemory(space: String = "default") throws -> SwiftDataQueueStore {
        SwiftDataQueueStore(container: try inMemoryContainer(), space: space)
    }

    public func scoped(to space: String) -> any QueueStore {
        SwiftDataQueueStore(container: container, space: space)
    }

    public func load() async throws -> PersistedQueue? {
        let context = ModelContext(container)
        let localSpace: String? = space
        let entries = try context.fetch(
            FetchDescriptor<StoredQueueEntry>(
                predicate: #Predicate { $0.space == localSpace },
                sortBy: [SortDescriptor(\StoredQueueEntry.order)]
            )
        )
        guard !entries.isEmpty else { return nil }
        let state = try context.fetch(
            FetchDescriptor<StoredQueueState>(predicate: #Predicate { $0.space == localSpace })
        ).first
        return PersistedQueue(
            items: entries.map {
                PlaybackService.Item(
                    id: $0.entryID,
                    trackID: $0.trackID,
                    title: $0.title,
                    artist: $0.artist,
                    album: $0.album,
                    streamPath: $0.streamPath
                )
            },
            currentIndex: state.flatMap { $0.currentIndex >= 0 ? $0.currentIndex : nil },
            position: state?.position ?? 0
        )
    }

    public func saveQueue(_ items: [PlaybackService.Item], currentIndex: Int?) async throws {
        let context = ModelContext(container)
        let localSpace: String? = space
        try context.delete(
            model: StoredQueueEntry.self,
            where: #Predicate { $0.space == localSpace }
        )
        try context.delete(
            model: StoredQueueState.self,
            where: #Predicate { $0.space == localSpace }
        )
        for (index, item) in items.enumerated() {
            context.insert(
                StoredQueueEntry(
                    space: space,
                    order: index,
                    entryID: item.id,
                    trackID: item.trackID,
                    title: item.title,
                    artist: item.artist,
                    album: item.album,
                    streamPath: item.streamPath
                )
            )
        }
        context.insert(
            StoredQueueState(space: space, currentIndex: currentIndex ?? -1, position: 0)
        )
        try context.save()
    }

    public func saveProgress(_ progress: QueueProgress) async throws {
        let context = ModelContext(container)
        let localSpace: String? = space
        if let state = try context.fetch(
            FetchDescriptor<StoredQueueState>(predicate: #Predicate { $0.space == localSpace })
        ).first {
            state.currentIndex = progress.index ?? -1
            state.position = progress.position
        } else {
            context.insert(
                StoredQueueState(
                    space: space,
                    currentIndex: progress.index ?? -1,
                    position: progress.position
                )
            )
        }
        try context.save()
    }

    public func clear() async throws {
        let context = ModelContext(container)
        let localSpace: String? = space
        try context.delete(
            model: StoredQueueEntry.self,
            where: #Predicate { $0.space == localSpace }
        )
        try context.delete(
            model: StoredQueueState.self,
            where: #Predicate { $0.space == localSpace }
        )
        try context.save()
    }
}
