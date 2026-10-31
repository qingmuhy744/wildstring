import Foundation

public struct MusicLibrary: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let enabled: Bool
    public let isDefault: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, enabled
        case isDefault = "is_default"
    }
}

public struct ListeningSummary: Decodable, Equatable, Sendable {
    public let playCount: Int
    public let listenedMs: Int64
    public let tracksPlayed: Int
    public let favorites: Int

    enum CodingKeys: String, CodingKey {
        case playCount = "play_count"
        case listenedMs = "listened_ms"
        case tracksPlayed = "tracks_played"
        case favorites
    }
}

public struct RankingRow: Decodable, Equatable, Sendable, Identifiable {
    public let rank: Int
    public let track: Track
    public let playCount: Int
    public let listenedMs: Int64
    public let reason: String

    public var id: String { track.id }

    enum CodingKeys: String, CodingKey {
        case rank, track, reason
        case playCount = "play_count"
        case listenedMs = "listened_ms"
    }
}

public struct RankingPage: Decodable, Equatable, Sendable {
    public let items: [RankingRow]
    public let total: Int
    public let scope: String
    public let period: String
    public let metric: String
}

public struct PodcastSummary: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let author: String
    public let description: String
    public let totalEpisodes: Int
    public let unplayedEpisodes: Int
    public let followed: Bool
    public let coverURL: URL?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        author = try container.decodeIfPresent(String.self, forKey: .author) ?? ""
        description = try container.decodeIfPresent(String.self, forKey: .description) ?? ""
        totalEpisodes = try container.decodeIfPresent(Int.self, forKey: .totalEpisodes) ?? 0
        unplayedEpisodes = try container.decodeIfPresent(Int.self, forKey: .unplayedEpisodes) ?? 0
        followed = try container.decodeIfPresent(Bool.self, forKey: .followed) ?? false
        coverURL = try container.decodeIfPresent(String.self, forKey: .coverURL).flatMap { value in
            guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
            return url
        }
    }

    enum CodingKeys: String, CodingKey {
        case id, title, author, description, followed
        case totalEpisodes = "total_episodes"
        case unplayedEpisodes = "unplayed_episodes"
        case coverURL = "cover_url"
    }
}

public struct PodcastEpisode: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let podcastId: String
    public let title: String
    public let description: String
    public let durationSeconds: Int
    public let positionSeconds: Int
    public let pubDate: String

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        podcastId = try container.decode(String.self, forKey: .podcastId)
        title = try container.decode(String.self, forKey: .title)
        description = try container.decodeIfPresent(String.self, forKey: .description) ?? ""
        durationSeconds = try container.decodeIfPresent(Int.self, forKey: .durationSeconds) ?? 0
        positionSeconds = try container.decodeIfPresent(Int.self, forKey: .positionSeconds) ?? 0
        pubDate = try container.decodeIfPresent(String.self, forKey: .pubDate) ?? ""
    }

    enum CodingKeys: String, CodingKey {
        case id, title, description
        case podcastId = "podcast_id"
        case durationSeconds = "duration_seconds"
        case positionSeconds = "position_seconds"
        case pubDate = "pub_date"
    }
}

public struct PodcastDetail: Decodable, Equatable, Sendable {
    public let podcast: PodcastSummary
    public let episodes: [PodcastEpisode]
}

public struct PodcastProgressSnapshot: Decodable, Equatable, Sendable {
    public let version: Int
    public let positionSeconds: Int

    enum CodingKeys: String, CodingKey {
        case version
        case positionSeconds = "position_seconds"
    }
}

extension WildstringClient {
    public func libraries() async throws -> [MusicLibrary] {
        let data = try await perform(Request(method: "GET", path: "api/v1/libraries"))
        return try JSONDecoder().decode([MusicLibrary].self, from: data)
    }

    public func reportListening(_ report: ListeningReport) async throws {
        _ = try await perform(
            Request(
                method: "POST",
                path: "api/v1/listening",
                body: try JSONEncoder().encode(report),
                contentType: "application/json"
            )
        )
    }

    public func listeningSummary() async throws -> ListeningSummary {
        let data = try await perform(Request(method: "GET", path: "api/v1/listening/summary"))
        return try JSONDecoder().decode(ListeningSummary.self, from: data)
    }

    public func rankings(scope: String, period: String, metric: String) async throws -> RankingPage {
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/recommendations/rankings",
                queryItems: [
                    URLQueryItem(name: "scope", value: scope),
                    URLQueryItem(name: "period", value: period),
                    URLQueryItem(name: "metric", value: metric),
                    URLQueryItem(name: "limit", value: "20"),
                ]
            )
        )
        return try JSONDecoder().decode(RankingPage.self, from: data)
    }

    public func podcasts(followed: Bool) async throws -> [PodcastSummary] {
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/podcasts",
                queryItems: [URLQueryItem(name: "followed", value: followed ? "true" : "false")]
            )
        )
        return try JSONDecoder().decode([PodcastSummary].self, from: data)
    }

    public func podcast(id: String) async throws -> PodcastDetail {
        let data = try await perform(Request(method: "GET", path: "api/v1/podcasts/\(id)"))
        return try JSONDecoder().decode(PodcastDetail.self, from: data)
    }

    public func podcastEpisode(id: String) async throws -> PodcastEpisode {
        let data = try await perform(Request(method: "GET", path: "api/v1/podcasts/episodes/\(id)"))
        return try JSONDecoder().decode(PodcastEpisode.self, from: data)
    }

    public func setPodcastFollowed(id: String, followed: Bool) async throws {
        struct Body: Encodable { let followed: Bool }
        _ = try await perform(
            Request(
                method: "PUT",
                path: "api/v1/podcasts/\(id)/follow",
                body: try JSONEncoder().encode(Body(followed: followed)),
                contentType: "application/json"
            )
        )
    }

    public func podcastProgress(episodeId: String) async throws -> PodcastProgressSnapshot {
        let data = try await perform(
            Request(method: "GET", path: "api/v1/podcasts/episodes/\(episodeId)/progress")
        )
        return try JSONDecoder().decode(PodcastProgressSnapshot.self, from: data)
    }

    public func savePodcastProgress(episodeId: String, write: PodcastProgressWrite) async throws {
        _ = try await perform(
            Request(
                method: "PUT",
                path: "api/v1/podcasts/episodes/\(episodeId)/progress",
                body: try JSONEncoder().encode(write),
                contentType: "application/json"
            )
        )
    }
}
