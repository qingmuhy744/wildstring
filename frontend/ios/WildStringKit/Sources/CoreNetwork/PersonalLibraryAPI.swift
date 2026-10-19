import Foundation

public struct Playlist: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let kind: String
    public let version: Int
    public let trackCount: Int
    public let durationMs: Int64
    public let coverTrackId: String

    enum CodingKeys: String, CodingKey {
        case id, name, kind, version
        case trackCount = "track_count"
        case durationMs = "duration_ms"
        case coverTrackId = "cover_track_id"
    }

    public var isFavorites: Bool { kind == "favorites" }
    public var isSmart: Bool { kind == "smart" }
    public var isEditable: Bool { kind == "manual" }
}

public struct RecommendationItem: Decodable, Equatable, Sendable, Identifiable {
    public let track: Track
    public let reason: String
    public let sourceIds: [String]?

    public var id: String { track.id }

    enum CodingKeys: String, CodingKey {
        case track, reason
        case sourceIds = "source_ids"
    }
}

public struct DailyRecommendations: Decodable, Equatable, Sendable {
    public let id: String
    public let date: String
    public let items: [RecommendationItem]
    public let degraded: Bool?
}

extension WildstringClient {
    // MARK: - Favorites

    public func favoriteIDs() async throws -> Set<String> {
        struct Payload: Decodable { let ids: [String] }
        let data = try await perform(Request(method: "GET", path: "api/v1/favorites/ids"))
        return Set(try JSONDecoder().decode(Payload.self, from: data).ids)
    }

    public func setFavorite(trackID: String, loved: Bool) async throws {
        struct Body: Encodable { let loved: Bool }
        _ = try await perform(
            Request(
                method: "PUT",
                path: "api/v1/tracks/\(trackID)/favorite",
                body: try JSONEncoder().encode(Body(loved: loved)),
                contentType: "application/json"
            )
        )
    }

    // MARK: - Playlists

    public func playlists(limit: Int = 100, offset: Int = 0) async throws -> Page<Playlist> {
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/playlists",
                queryItems: [
                    URLQueryItem(name: "limit", value: String(limit)),
                    URLQueryItem(name: "offset", value: String(offset)),
                ]
            )
        )
        return try JSONDecoder().decode(Page<Playlist>.self, from: data)
    }

    public func playlist(id: String) async throws -> Playlist {
        let data = try await perform(Request(method: "GET", path: "api/v1/playlists/\(id)"))
        return try JSONDecoder().decode(Playlist.self, from: data)
    }

    public func playlistTracks(
        playlistID: String,
        limit: Int = 200,
        offset: Int = 0
    ) async throws -> Page<Track> {
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/playlists/\(playlistID)/tracks",
                queryItems: [
                    URLQueryItem(name: "limit", value: String(limit)),
                    URLQueryItem(name: "offset", value: String(offset)),
                ]
            )
        )
        return try JSONDecoder().decode(Page<Track>.self, from: data)
    }

    public func createPlaylist(name: String) async throws -> Playlist {
        struct Body: Encodable {
            let name: String
            let kind: String
        }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/playlists",
                body: try JSONEncoder().encode(Body(name: name, kind: "manual")),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(Playlist.self, from: data)
    }

    public func renamePlaylist(
        id: String,
        name: String,
        version: Int,
        kind: String
    ) async throws -> Playlist {
        struct Body: Encodable {
            let name: String
            let version: Int
            let kind: String
        }
        let data = try await perform(
            Request(
                method: "PUT",
                path: "api/v1/playlists/\(id)",
                body: try JSONEncoder().encode(Body(name: name, version: version, kind: kind)),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(Playlist.self, from: data)
    }

    public func deletePlaylist(playlistID: String, version: Int) async throws {
        _ = try await perform(
            Request(
                method: "DELETE",
                path: "api/v1/playlists/\(playlistID)",
                queryItems: [URLQueryItem(name: "version", value: String(version))]
            )
        )
    }

    public func addTracks(playlistID: String, trackIDs: [String], version: Int) async throws {
        struct Body: Encodable {
            let version: Int
            let trackIds: [String]

            enum CodingKeys: String, CodingKey {
                case version
                case trackIds = "track_ids"
            }
        }
        _ = try await perform(
            Request(
                method: "POST",
                path: "api/v1/playlists/\(playlistID)/tracks",
                body: try JSONEncoder().encode(Body(version: version, trackIds: trackIDs)),
                contentType: "application/json"
            )
        )
    }

    public func removeTrack(playlistID: String, trackID: String, version: Int) async throws {
        _ = try await perform(
            Request(
                method: "DELETE",
                path: "api/v1/playlists/\(playlistID)/tracks/\(trackID)",
                queryItems: [URLQueryItem(name: "version", value: String(version))]
            )
        )
    }

    // MARK: - Daily recommendations

    public func dailyRecommendations() async throws -> DailyRecommendations {
        let data = try await perform(
            Request(method: "GET", path: "api/v1/recommendations/daily", timeout: 60)
        )
        return try JSONDecoder().decode(DailyRecommendations.self, from: data)
    }

    public func refreshDailyRecommendations() async throws -> DailyRecommendations {
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/recommendations/daily/refresh",
                timeout: 90
            )
        )
        return try JSONDecoder().decode(DailyRecommendations.self, from: data)
    }
}
