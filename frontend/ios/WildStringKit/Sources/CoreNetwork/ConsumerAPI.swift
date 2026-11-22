import Foundation

extension WildstringClient {
    func consumerGet<Result: Decodable>(
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws -> Result {
        let data = try await perform(Request(method: "GET", path: "api/v1/" + path, queryItems: query))
        return try JSONDecoder().decode(Result.self, from: data)
    }

    @discardableResult
    func consumerWrite<Body: Encodable>(
        _ method: String, _ path: String, _ body: Body
    ) async throws -> Data {
        try await perform(Request(
            method: method, path: "api/v1/" + path,
            body: try JSONEncoder().encode(body), contentType: "application/json"
        ))
    }

    @discardableResult
    func consumerAction(_ method: String, _ path: String) async throws -> Data {
        try await perform(Request(method: method, path: "api/v1/" + path))
    }
}

public struct EditableAlbum: Decodable, Sendable {
    public struct TrackVersion: Decodable, Sendable {
        let trackID: String
        let metadataVersion: Int

        enum CodingKeys: String, CodingKey {
            case trackID = "track_id"
            case metadataVersion = "metadata_version"
        }
    }

    public let albumID: String
    public let title: String
    public let artists: [String]
    public let releaseDate: String
    public let description: String
    public let label: String
    public let catalogNumber: String
    let tracks: [TrackVersion]

    enum CodingKeys: String, CodingKey {
        case albumID = "album_id"
        case title = "primary_title"
        case artists = "primary_artists"
        case releaseDate = "release_date"
        case catalogNumber = "catalog_number"
        case description, label, tracks
    }
}

public struct AlbumTagEdits: Encodable, Sendable {
    public var album: String?
    public var albumArtists: [String]?
    public var releaseDate: String?
    public var description: String?
    public var label: String?
    public var catalogNumber: String?

    public init() {}

    enum CodingKeys: String, CodingKey {
        case albumArtists = "album_artists"
        case releaseDate = "release_date"
        case catalogNumber = "catalog_number"
        case album, description, label
    }
}

public struct OnlineLyricCandidate: Decodable, Identifiable, Sendable {
    public let id: String
    public let provider: String?
    public let normalized: Lyrics
    public let version: Int
    public let fileVersion: String

    enum CodingKeys: String, CodingKey {
        case id, provider, normalized
        case version = "lyrics_version"
        case fileVersion = "file_version"
    }
}

public struct OnlineLyricResults: Decodable, Sendable {
    public struct Job: Decodable, Sendable {
        public let status: String
        public let error: String?
    }
    public let items: [OnlineLyricCandidate]
    public let jobs: [Job]
}

extension WildstringClient {
    public func editableAlbum(id: String) async throws -> EditableAlbum {
        try await consumerGet("manage/metadata/albums", query: [URLQueryItem(name: "album_id", value: id)])
    }

    public func saveAlbum(_ album: EditableAlbum, edits: AlbumTagEdits) async throws -> String {
        struct Body: Encodable {
            struct Track: Encodable {
                let track_id: String
                let version: Int
            }
            let album_id: String
            let tracks: [Track]
            let overrides: AlbumTagEdits
        }
        struct Result: Decodable { let album_id: String }
        let body = Body(
            album_id: album.albumID,
            tracks: album.tracks.map { Body.Track(track_id: $0.trackID, version: $0.metadataVersion) },
            overrides: edits
        )
        let data = try await consumerWrite("PUT", "manage/metadata/albums", body)
        return try JSONDecoder().decode(Result.self, from: data).album_id
    }

    public func onlineLyrics(trackID: String) async throws -> OnlineLyricResults {
        try await consumerGet("manage/tracks/\(trackID)/online-lyrics")
    }

    public func searchOnlineLyrics(trackID: String) async throws {
        try await consumerAction("POST", "manage/tracks/\(trackID)/online-lyrics")
    }

    public func applyOnlineLyrics(_ candidate: OnlineLyricCandidate, offset: Int) async throws {
        struct Body: Encodable {
            let version: Int
            let file_version: String
            let offset_ms: Int
        }
        try await consumerWrite("POST", "manage/lyric-candidates/\(candidate.id)/apply",
                                Body(version: candidate.version, file_version: candidate.fileVersion, offset_ms: offset))
    }

    public func playlistWithRules(id: String) async throws -> (Playlist, String?) {
        let data = try await perform(Request(method: "GET", path: "api/v1/playlists/\(id)"))
        let record = try JSONDecoder().decode(Playlist.self, from: data)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let definition = object?["definition"] as? [String: Any] else { return (record, nil) }
        let formatted = try JSONSerialization.data(withJSONObject: definition, options: [.prettyPrinted, .sortedKeys])
        return (record, String(decoding: formatted, as: UTF8.self))
    }

    public func saveUserPlaylist(name: String, previous: Playlist?, rules: String?) async throws -> Playlist {
        var body: [String: Any] = ["name": name, "kind": rules == nil ? "manual" : "smart"]
        if let rules {
            guard let definition = try JSONSerialization.jsonObject(with: Data(rules.utf8)) as? [String: Any] else {
                throw APIError(statusCode: 422, code: "invalid_playlist_rules")
            }
            body["definition"] = definition
        }
        if let previous { body["version"] = previous.version }
        let path = previous.map { "api/v1/playlists/\($0.id)" } ?? "api/v1/playlists"
        let data = try await perform(Request(
            method: previous == nil ? "POST" : "PUT", path: path,
            body: try JSONSerialization.data(withJSONObject: body), contentType: "application/json"
        ))
        return try JSONDecoder().decode(Playlist.self, from: data)
    }
}
