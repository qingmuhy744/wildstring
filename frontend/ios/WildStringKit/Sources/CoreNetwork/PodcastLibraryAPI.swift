import Foundation

public struct PodcastPublisher: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
}

public struct PodcastPublisherLibrary: Decodable, Sendable {
    public let publisher: PodcastPublisher
    public let podcasts: [PodcastSummary]
}

public struct PodcastFavoriteEpisode: Decodable, Sendable, Identifiable {
    public let episode: PodcastEpisode
    public let podcastTitle: String
    public var id: String { episode.id }

    enum CodingKeys: String, CodingKey { case podcastTitle = "podcast_title" }

    public init(from decoder: Decoder) throws {
        episode = try PodcastEpisode(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        podcastTitle = try container.decode(String.self, forKey: .podcastTitle)
    }
}

public struct PodcastPersonalDownloadSettings: Decodable, Sendable {
    public let version: Int
    public var downloadPolicy: String
    public var retentionPolicy: String
    public let slowDownload: Bool

    enum CodingKeys: String, CodingKey {
        case version
        case downloadPolicy = "download_policy"
        case retentionPolicy = "retention_policy"
        case slowDownload = "slow_download"
    }
}

public struct PodcastDownloadTask: Decodable, Sendable, Identifiable {
    public let episodeID: String
    public let podcastID: String
    public let title: String
    public let podcastTitle: String
    public let status: String
    public let progress: Double?
    public let error: String?
    public var id: String { episodeID }

    enum CodingKeys: String, CodingKey {
        case status, error
        case episodeID = "episode_id"
        case podcastID = "podcast_id"
        case title = "episode_title"
        case podcastTitle = "podcast_title"
        case progress = "progress_pct"
    }
}

public struct PodcastDownloadTasks: Decodable, Sendable {
    public let downloading: [PodcastDownloadTask]
    public let queued: [PodcastDownloadTask]
    public let recentCompleted: [PodcastDownloadTask]
    public let failed: [PodcastDownloadTask]

    enum CodingKeys: String, CodingKey {
        case downloading, queued, failed
        case recentCompleted = "recent_completed"
    }
}

public struct PodcastCachePreferences: Codable, Sendable {
    public let version: Int
    public var autoCacheCurrent: Bool
    public var prefetchNext: Bool
    public var networkPolicy: String

    enum CodingKeys: String, CodingKey {
        case version
        case autoCacheCurrent = "auto_cache_current"
        case prefetchNext = "prefetch_next"
        case networkPolicy = "network_policy"
    }
}

extension WildstringClient {
    public func allPodcasts() async throws -> [PodcastSummary] {
        try await consumerGet("podcasts")
    }

    public func podcastPublishers() async throws -> [PodcastPublisher] {
        try await consumerGet("podcasts/publishers")
    }

    public func podcastPublisher(id: String) async throws -> PodcastPublisherLibrary {
        try await consumerGet("podcasts/publishers/\(id)")
    }

    public func assignPodcastPublisher(
        show: PodcastSummary, publisherID: String?, name: String?
    ) async throws -> PodcastDetail {
        struct Update: Encodable {
            let version: Int
            let publisher_id: String?
            let name: String?
        }
        let data = try await consumerWrite("PUT", "podcasts/\(show.id)/publisher", Update(
            version: show.publisherVersion, publisher_id: publisherID, name: name
        ))
        return try JSONDecoder().decode(PodcastDetail.self, from: data)
    }

    public func podcastFavorites() async throws -> [PodcastFavoriteEpisode] {
        try await consumerGet("podcasts/favorites")
    }

    public func setPodcastEpisodeSaved(id: String, saved: Bool) async throws {
        try await consumerAction(saved ? "POST" : "DELETE", "podcasts/episodes/\(id)/download")
    }

    public func podcastDownloadSettings(id: String) async throws -> PodcastPersonalDownloadSettings {
        try await consumerGet("podcasts/\(id)/download-settings")
    }

    public func savePodcastDownloadSettings(
        id: String, settings: PodcastPersonalDownloadSettings
    ) async throws -> PodcastPersonalDownloadSettings {
        struct Update: Encodable {
            let version: Int
            let download_policy: String
            let retention_policy: String
        }
        let data = try await consumerWrite("PUT", "podcasts/\(id)/download-settings", Update(
            version: settings.version,
            download_policy: settings.downloadPolicy,
            retention_policy: settings.retentionPolicy
        ))
        return try JSONDecoder().decode(PodcastPersonalDownloadSettings.self, from: data)
    }

    public func podcastDownloadTasks(all: Bool) async throws -> PodcastDownloadTasks {
        try await consumerGet(all ? "podcasts/downloads/queue" : "podcasts/downloads/mine")
    }

    public func retryPodcastDownloadTasks() async throws {
        try await consumerAction("POST", "podcasts/downloads/retry-failed")
    }

    public func podcastCachePreferences() async throws -> PodcastCachePreferences {
        try await consumerGet("podcasts/playback-settings")
    }

    public func savePodcastCachePreferences(_ value: PodcastCachePreferences) async throws -> PodcastCachePreferences {
        let data = try await consumerWrite("PUT", "podcasts/playback-settings", value)
        return try JSONDecoder().decode(PodcastCachePreferences.self, from: data)
    }
}
