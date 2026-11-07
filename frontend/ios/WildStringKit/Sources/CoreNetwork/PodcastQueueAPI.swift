import Foundation

/// Stable id sent with podcast queue writes. Prefer the playback device id the
/// app already uses; only mint a UUID when that id is missing.
public enum WildstringDeviceID {
    public static let storageKey = "wildstring.device-id"

    public static func resolve(preferred: String, defaults: UserDefaults = .standard) -> String {
        let trimmed = preferred.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        if let stored = defaults.string(forKey: storageKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !stored.isEmpty
        {
            return stored
        }
        let created = UUID().uuidString
        defaults.set(created, forKey: storageKey)
        return created
    }
}

public struct PodcastQueueItem: Codable, Equatable, Sendable, Identifiable {
    public var episodeId: String
    public var origin: String
    public var id: String { episodeId }

    public init(episodeId: String, origin: String = "manual") {
        self.episodeId = episodeId
        self.origin = origin
    }

    enum CodingKeys: String, CodingKey {
        case episodeId = "episode_id"
        case origin
    }
}

public struct PodcastQueueState: Decodable, Equatable, Sendable {
    public var version: Int
    public var deviceId: String
    public var items: [PodcastQueueItem]
    public var updatedAt: String?

    public init(
        version: Int,
        deviceId: String = "",
        items: [PodcastQueueItem],
        updatedAt: String? = nil
    ) {
        self.version = version
        self.deviceId = deviceId
        self.items = items
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case version
        case deviceId = "device_id"
        case items
        case updatedAt = "updated_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        deviceId = try container.decodeIfPresent(String.self, forKey: .deviceId) ?? ""
        items = try container.decodeIfPresent([PodcastQueueItem].self, forKey: .items) ?? []
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
    }
}

public struct PodcastQueueUpdate: Encodable, Equatable, Sendable {
    public var version: Int
    public var deviceId: String
    public var items: [PodcastQueueItem]

    public init(version: Int, deviceId: String, items: [PodcastQueueItem]) {
        self.version = version
        self.deviceId = deviceId
        self.items = items
    }

    enum CodingKeys: String, CodingKey {
        case version
        case deviceId = "device_id"
        case items
    }
}

/// 409 from `PUT /podcasts/queue`. The local queue stays; `current` is the server copy.
public struct PodcastQueueConflict: Error, Equatable, Sendable {
    public let current: PodcastQueueState

    public init(current: PodcastQueueState) {
        self.current = current
    }

    static func decode(from data: Data) -> PodcastQueueConflict? {
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
            envelope.detail.code == "podcast_queue_conflict"
        else { return nil }
        return PodcastQueueConflict(current: envelope.detail.current)
    }

    private struct Envelope: Decodable {
        struct Detail: Decodable {
            let code: String
            let current: PodcastQueueState
        }
        let detail: Detail
    }
}

public struct PodcastInboxItem: Codable, Equatable, Sendable, Identifiable {
    public var episodeId: String
    public var podcastId: String
    public var source: String
    public var addedAt: String
    public var id: String { episodeId }

    public init(episodeId: String, podcastId: String, source: String, addedAt: String) {
        self.episodeId = episodeId
        self.podcastId = podcastId
        self.source = source
        self.addedAt = addedAt
    }

    enum CodingKeys: String, CodingKey {
        case episodeId = "episode_id"
        case podcastId = "podcast_id"
        case source
        case addedAt = "added_at"
    }
}

public struct PodcastInbox: Decodable, Equatable, Sendable {
    public var version: Int
    public var items: [PodcastInboxItem]

    public init(version: Int, items: [PodcastInboxItem]) {
        self.version = version
        self.items = items
    }
}

public struct PodcastShowPreference: Codable, Equatable, Sendable {
    public var action: String
    public var autoLimit: Int
    public var order: String
    public var skipCompleted: Bool
    public var autoContinue: Bool

    public init(
        action: String = "inbox",
        autoLimit: Int = 3,
        order: String = "follow",
        skipCompleted: Bool = true,
        autoContinue: Bool = true
    ) {
        self.action = action
        self.autoLimit = min(100, max(0, autoLimit))
        self.order = order
        self.skipCompleted = skipCompleted
        self.autoContinue = autoContinue
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(action, forKey: .action)
        try container.encode(autoLimit, forKey: .autoLimit)
        try container.encode(order, forKey: .order)
        try container.encode(skipCompleted, forKey: .skipCompleted)
        try container.encode(autoContinue, forKey: .autoContinue)
    }

    enum CodingKeys: String, CodingKey {
        case action
        case autoLimit = "auto_limit"
        case order
        case skipCompleted = "skip_completed"
        case autoContinue = "auto_continue"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let action = try container.decodeIfPresent(String.self, forKey: .action) ?? "inbox"
        let autoLimit = try container.decodeIfPresent(Int.self, forKey: .autoLimit) ?? 3
        let order = try container.decodeIfPresent(String.self, forKey: .order) ?? "follow"
        let skipCompleted = try container.decodeIfPresent(Bool.self, forKey: .skipCompleted) ?? true
        let autoContinue = try container.decodeIfPresent(Bool.self, forKey: .autoContinue) ?? true
        self.init(
            action: action,
            autoLimit: autoLimit,
            order: order,
            skipCompleted: skipCompleted,
            autoContinue: autoContinue
        )
    }
}

public struct PodcastQueuePreferences: Codable, Equatable, Sendable {
    public var defaultAction: String
    public var autoLimit: Int
    public var shows: [String: PodcastShowPreference]

    public init(
        defaultAction: String = "inbox",
        autoLimit: Int = 3,
        shows: [String: PodcastShowPreference] = [:]
    ) {
        self.defaultAction = defaultAction
        self.autoLimit = autoLimit
        self.shows = shows
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(defaultAction, forKey: .defaultAction)
        try container.encode(autoLimit, forKey: .autoLimit)
        try container.encode(shows, forKey: .shows)
    }

    enum CodingKeys: String, CodingKey {
        case defaultAction = "default_action"
        case autoLimit = "auto_limit"
        case shows
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        defaultAction = try container.decodeIfPresent(String.self, forKey: .defaultAction) ?? "inbox"
        autoLimit = try container.decodeIfPresent(Int.self, forKey: .autoLimit) ?? 3
        shows = try container.decodeIfPresent([String: PodcastShowPreference].self, forKey: .shows) ?? [:]
    }
}

/// Pure edits for the cloud 待播 queue. Auto-continue is never an input, so it cannot be written.
public enum PodcastQueueMerge {
    public static let limit = 5000

    /// On-demand play: the chosen episode becomes the head, origin `manual`. Every other entry stays.
    public static func playing(_ episodeID: String, queue: [PodcastQueueItem]) -> [PodcastQueueItem] {
        let rest = queue.filter { $0.episodeId != episodeID }
        return [PodcastQueueItem(episodeId: episodeID, origin: "manual")] + rest
    }

    /// `next` inserts after the current episode (or at the head). Otherwise append.
    /// An existing copy is not stacked. A new entry is `manual` and nothing else is added.
    public static func enqueue(
        _ episodeID: String,
        queue: [PodcastQueueItem],
        next: Bool,
        after currentID: String?
    ) -> [PodcastQueueItem] {
        let exists = queue.contains { $0.episodeId == episodeID }
        if !exists, queue.count >= limit { return queue }
        if next {
            var rest = queue.filter { $0.episodeId != episodeID }
            let entry = PodcastQueueItem(episodeId: episodeID, origin: "manual")
            if let currentID, let index = rest.firstIndex(where: { $0.episodeId == currentID }) {
                rest.insert(entry, at: index + 1)
            } else {
                rest.insert(entry, at: 0)
            }
            return rest
        }
        if exists {
            return queue.map { item in
                guard item.episodeId == episodeID, item.origin != "manual" else { return item }
                return PodcastQueueItem(episodeId: item.episodeId, origin: "manual")
            }
        }
        return queue + [PodcastQueueItem(episodeId: episodeID, origin: "manual")]
    }

    /// Drop the episode that just finished. Other entries, including ones not played, stay.
    public static func finished(_ episodeID: String, queue: [PodcastQueueItem]) -> [PodcastQueueItem] {
        queue.filter { $0.episodeId != episodeID }
    }

    /// Dragging a `rule` entry turns it into `manual`. Unmoved entries keep their origin.
    public static func moving(
        _ items: [PodcastQueueItem],
        from offsets: IndexSet,
        to destination: Int
    ) -> [PodcastQueueItem] {
        var result = items
        let moving = offsets.sorted().map { index -> PodcastQueueItem in
            let item = result[index]
            guard item.origin == "rule" else { return item }
            return PodcastQueueItem(episodeId: item.episodeId, origin: "manual")
        }
        for index in offsets.sorted(by: >) {
            result.remove(at: index)
        }
        let insertion = destination - offsets.filter { $0 < destination }.count
        let clamped = min(max(0, insertion), result.count)
        result.insert(contentsOf: moving, at: clamped)
        return result
    }
}

extension WildstringClient {
    public func podcastInbox() async throws -> PodcastInbox {
        let data = try await perform(Request(method: "GET", path: "api/v1/podcasts/inbox"))
        return try JSONDecoder().decode(PodcastInbox.self, from: data)
    }

    public func addPodcastInboxItem(episodeID: String) async throws {
        _ = try await perform(
            Request(method: "PUT", path: "api/v1/podcasts/inbox/items/\(Self.queuePath(episodeID))")
        )
    }

    public func removePodcastInboxItem(episodeID: String) async throws {
        _ = try await perform(
            Request(method: "DELETE", path: "api/v1/podcasts/inbox/items/\(Self.queuePath(episodeID))")
        )
    }

    public func podcastQueue() async throws -> PodcastQueueState {
        let data = try await perform(Request(method: "GET", path: "api/v1/podcasts/queue"))
        return try JSONDecoder().decode(PodcastQueueState.self, from: data)
    }

    /// Replaces the queue. A version mismatch throws `PodcastQueueConflict` and does not succeed.
    public func replacePodcastQueue(_ update: PodcastQueueUpdate) async throws -> PodcastQueueState {
        do {
            let data = try await perform(
                Request(
                    method: "PUT",
                    path: "api/v1/podcasts/queue",
                    body: try JSONEncoder().encode(update),
                    contentType: "application/json"
                )
            )
            return try JSONDecoder().decode(PodcastQueueState.self, from: data)
        } catch let error as APIError where error.statusCode == 409 {
            if let conflict = PodcastQueueConflict.decode(from: error.body) {
                throw conflict
            }
            throw error
        }
    }

    public func podcastQueuePreferences() async throws -> PodcastQueuePreferences {
        let data = try await perform(Request(method: "GET", path: "api/v1/podcasts/queue/preferences"))
        return try JSONDecoder().decode(PodcastQueuePreferences.self, from: data)
    }

    public func savePodcastQueuePreferences(
        _ preferences: PodcastQueuePreferences
    ) async throws -> PodcastQueuePreferences {
        let data = try await perform(
            Request(
                method: "PUT",
                path: "api/v1/podcasts/queue/preferences",
                body: try JSONEncoder().encode(preferences),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(PodcastQueuePreferences.self, from: data)
    }

    private static func queuePath(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
