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

extension WildstringClient {
    public func albums(limit: Int = 50, offset: Int = 0, query: String? = nil) async throws
        -> Page<Album>
    {
        try await page(path: "api/v1/albums", limit: limit, offset: offset, query: query)
    }

    public func albumTracks(albumId: String, limit: Int = 200, offset: Int = 0) async throws
        -> Page<Track>
    {
        try await page(
            path: "api/v1/albums/\(albumId)/tracks",
            limit: limit,
            offset: offset,
            query: nil
        )
    }

    public func artists(limit: Int = 50, offset: Int = 0, query: String? = nil) async throws
        -> Page<Artist>
    {
        try await page(path: "api/v1/artists", limit: limit, offset: offset, query: query)
    }

    public func artistTracks(artistId: String, limit: Int = 200, offset: Int = 0) async throws
        -> Page<Track>
    {
        try await page(
            path: "api/v1/artists/\(artistId)/tracks",
            limit: limit,
            offset: offset,
            query: nil
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

    private func page<Element: Decodable & Sendable>(
        path: String,
        limit: Int,
        offset: Int,
        query: String?
    ) async throws -> Page<Element> {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
        ]
        if let query, !query.isEmpty {
            queryItems.insert(URLQueryItem(name: "q", value: query), at: 0)
        }
        let data = try await perform(
            Request(method: "GET", path: path, queryItems: queryItems)
        )
        return try JSONDecoder().decode(Page<Element>.self, from: data)
    }
}
