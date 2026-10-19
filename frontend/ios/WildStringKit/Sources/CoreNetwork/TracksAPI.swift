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

extension WildstringClient {
    /// Paged track listing; mirrors `GET /api/v1/tracks`.
    public func tracks(limit: Int = 50, offset: Int = 0, query: String? = nil) async throws
        -> Page<Track>
    {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
        ]
        if let query, !query.isEmpty {
            queryItems.insert(URLQueryItem(name: "q", value: query), at: 0)
        }
        let data = try await perform(
            Request(method: "GET", path: "api/v1/tracks", queryItems: queryItems)
        )
        return try JSONDecoder().decode(Page<Track>.self, from: data)
    }
}
