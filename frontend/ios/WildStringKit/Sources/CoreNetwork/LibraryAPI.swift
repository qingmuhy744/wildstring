import Foundation

public struct Album: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let artists: [String]
    public let trackCount: Int
    public let durationMs: Int64
    public let coverTrackId: String

    enum CodingKeys: String, CodingKey {
        case id, title, artists
        case trackCount = "track_count"
        case durationMs = "duration_ms"
        case coverTrackId = "cover_track_id"
    }
}

public struct Artist: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let trackCount: Int
    public let albumCount: Int
    public let durationMs: Int64
    public let coverTrackId: String

    enum CodingKeys: String, CodingKey {
        case id, name
        case trackCount = "track_count"
        case albumCount = "album_count"
        case durationMs = "duration_ms"
        case coverTrackId = "cover_track_id"
    }
}

public enum TrackSort: String, CaseIterable, Sendable {
    case title
    case name
    case trackNumber = "track_number"
    case addedAt = "added_at"
    case duration = "duration_ms"
    case playCount = "play_count"
    case listened = "listened_ms"
    case lastPlayed = "last_played_at"

    /// Servers without explicit sorting still understand `title`; new clients
    /// use `name` for library-wide alphabetical order.
    public var queryValue: String { rawValue }
}

public enum AlbumSort: String, CaseIterable, Sendable {
    case title
    case artist
    case addedAt = "added_at"
    case releaseDate = "release_date"
}

public enum CatalogSortOrder: String, CaseIterable, Sendable {
    case asc
    case desc
}

public struct DiscSummary: Decodable, Equatable, Sendable {
    public let number: Int
    public let trackCount: Int
    public let durationMs: Int64
    public let offset: Int

    enum CodingKeys: String, CodingKey {
        case number, offset
        case trackCount = "track_count"
        case durationMs = "duration_ms"
    }
}

/// Album track page adds disc summaries so headers stay accurate across pages.
public struct AlbumTrackPage: Decodable, Sendable {
    public let items: [Track]
    public let discs: [DiscSummary]
    public let total: Int
    public let limit: Int
    public let offset: Int
}

extension WildstringClient {
    public func albums(
        limit: Int = 50,
        offset: Int = 0,
        query: String? = nil,
        sort: AlbumSort = .title,
        order: CatalogSortOrder? = nil
    ) async throws -> Page<Album> {
        try await sortedPage(
            path: "api/v1/albums",
            limit: limit,
            offset: offset,
            query: query,
            sort: sort.rawValue,
            order: order
        )
    }

    /// Album tracks default to disc/track order; callers may request other sorts.
    public func albumTracks(
        albumId: String,
        limit: Int = 200,
        offset: Int = 0,
        sort: TrackSort = .trackNumber,
        order: CatalogSortOrder? = nil
    ) async throws -> AlbumTrackPage {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "sort", value: sort.rawValue),
        ]
        if let order {
            queryItems.append(URLQueryItem(name: "order", value: order.rawValue))
        }
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/albums/\(albumId)/tracks",
                queryItems: queryItems
            )
        )
        return try JSONDecoder().decode(AlbumTrackPage.self, from: data)
    }

    public func artists(
        limit: Int = 50,
        offset: Int = 0,
        query: String? = nil,
        role: String? = nil
    ) async throws -> Page<Artist> {
        try await page(
            path: "api/v1/artists",
            limit: limit,
            offset: offset,
            query: query,
            role: role
        )
    }

    public func artistTracks(
        artistId: String,
        limit: Int = 200,
        offset: Int = 0,
        sort: TrackSort = .title,
        order: CatalogSortOrder? = nil
    ) async throws -> Page<Track> {
        try await sortedPage(
            path: "api/v1/artists/\(artistId)/tracks",
            limit: limit,
            offset: offset,
            query: nil,
            sort: sort.rawValue,
            order: order
        )
    }

    public func artistAlbums(artistId: String, limit: Int = 50, offset: Int = 0) async throws
        -> Page<Album>
    {
        try await page(
            path: "api/v1/artists/\(artistId)/albums",
            limit: limit,
            offset: offset,
            query: nil
        )
    }

    /// Raw payload for auxiliary assets such as cover art, using the same session.
    public func authorizedData(path: String) async throws -> Data {
        try await perform(Request(method: "GET", path: path))
    }

    private func sortedPage<Element: Decodable & Sendable>(
        path: String,
        limit: Int,
        offset: Int,
        query: String?,
        sort: String,
        order: CatalogSortOrder?
    ) async throws -> Page<Element> {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "sort", value: sort),
        ]
        if let query, !query.isEmpty {
            queryItems.insert(URLQueryItem(name: "q", value: query), at: 0)
        }
        if let order {
            queryItems.append(URLQueryItem(name: "order", value: order.rawValue))
        }
        let data = try await perform(
            Request(method: "GET", path: path, queryItems: queryItems)
        )
        return try JSONDecoder().decode(Page<Element>.self, from: data)
    }

    private func page<Element: Decodable & Sendable>(
        path: String,
        limit: Int,
        offset: Int,
        query: String?,
        role: String? = nil
    ) async throws -> Page<Element> {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
        ]
        if let query, !query.isEmpty {
            queryItems.insert(URLQueryItem(name: "q", value: query), at: 0)
        }
        if let role, !role.isEmpty {
            queryItems.append(URLQueryItem(name: "role", value: role))
        }
        let data = try await perform(
            Request(method: "GET", path: path, queryItems: queryItems)
        )
        return try JSONDecoder().decode(Page<Element>.self, from: data)
    }
}
