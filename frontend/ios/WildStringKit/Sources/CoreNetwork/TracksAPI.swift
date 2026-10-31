import Foundation

public struct Track: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let artists: [String]
    public let album: String?
    public let durationMs: Int64
    public let hasCover: Bool
    public let albumId: String?
    public let trackNumber: Int?
    public let discNumber: Int?

    enum CodingKeys: String, CodingKey {
        case id, title, artists, album
        case durationMs = "duration_ms"
        case hasCover = "has_cover"
        case albumId = "album_id"
        case trackNumber = "track_number"
        case discNumber = "disc_number"
    }
}

public struct Page<Element: Decodable & Sendable>: Decodable, Sendable {
    public let items: [Element]
    public let total: Int
    public let limit: Int
    public let offset: Int
}

public struct BrowseGroup: Decodable, Equatable, Sendable {
    public let key: String
    public let offset: Int?
    public let count: Int
}

public struct BrowseIndex: Decodable, Equatable, Sendable {
    public let kind: String
    public let total: Int
    public let groups: [BrowseGroup]
}

extension WildstringClient {
    /// Name-group index (28 groups) used for alphabet positioning.
    public func browseIndex(kind: String = "tracks", query: String? = nil) async throws
        -> BrowseIndex
    {
        var queryItems = [URLQueryItem(name: "kind", value: kind)]
        if let query, !query.isEmpty {
            queryItems.append(URLQueryItem(name: "q", value: query))
        }
        let data = try await perform(
            Request(method: "GET", path: "api/v1/browse-index", queryItems: queryItems)
        )
        return try JSONDecoder().decode(BrowseIndex.self, from: data)
    }
}

extension WildstringClient {
    /// Paged track listing; mirrors `GET /api/v1/tracks`.
    public func tracks(
        limit: Int = 50,
        offset: Int = 0,
        query: String? = nil,
        sort: TrackSort = .title,
        order: CatalogSortOrder? = nil,
        playedOnly: Bool = false
    ) async throws -> Page<Track> {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "sort", value: sort.rawValue),
        ]
        if let query, !query.isEmpty {
            queryItems.insert(URLQueryItem(name: "q", value: query), at: 0)
        }
        if let order {
            queryItems.append(URLQueryItem(name: "order", value: order.rawValue))
        }
        if playedOnly {
            queryItems.append(URLQueryItem(name: "played_only", value: "true"))
        }
        let data = try await perform(
            Request(method: "GET", path: "api/v1/tracks", queryItems: queryItems)
        )
        return try JSONDecoder().decode(Page<Track>.self, from: data)
    }
}
