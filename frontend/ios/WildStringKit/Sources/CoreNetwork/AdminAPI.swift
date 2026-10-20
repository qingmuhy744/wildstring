import Foundation

public struct ScanCounts: Decodable, Equatable, Sendable {
    public let visited: Int?
    public let added: Int?
    public let updated: Int?
    public let unchanged: Int?
    public let errors: Int?
    public let missing: Int?
    public let skipped: Int?
}

public struct ScanErrorDetail: Decodable, Equatable, Sendable {
    public let code: String?
    public let path: String?
    public let message: String?
}

public struct ScanRecord: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let status: String
    public let startedAt: String?
    public let finishedAt: String?
    public let counts: ScanCounts?
    public let errors: [ScanErrorDetail]?

    enum CodingKeys: String, CodingKey {
        case id, status, counts, errors
        case startedAt = "started_at"
        case finishedAt = "finished_at"
    }
}

public struct ImportRecord: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let status: String?
    public let startedAt: String?
    public let counts: [String: Int]?
    public let errors: [ScanErrorDetail]?

    enum CodingKeys: String, CodingKey {
        case id, status, counts, errors
        case startedAt = "started_at"
    }
}

public struct MetadataFields: Decodable, Equatable, Sendable {
    public let title: String?
    public let artists: [String]?
    public let album: String?
    public let albumArtists: [String]?
    public let trackNumber: Int?
    public let discNumber: Int?
    public let trackTotal: Int?
    public let discTotal: Int?
    public let description: String?
    public let releaseDate: String?

    enum CodingKeys: String, CodingKey {
        case title, artists, album, description
        case albumArtists = "album_artists"
        case trackNumber = "track_number"
        case discNumber = "disc_number"
        case trackTotal = "track_total"
        case discTotal = "disc_total"
        case releaseDate = "release_date"
    }
}

public struct ManagedMetadata: Decodable, Equatable, Sendable {
    public let trackID: String
    public let version: Int
    public let observed: MetadataFields
    public let overrides: MetadataFields
    public let effective: MetadataFields

    enum CodingKeys: String, CodingKey {
        case version, observed, overrides, effective
        case trackID = "track_id"
    }
}

/// Patch-style metadata overrides; only fields that were set are sent.
public struct MetadataOverrides: Encodable, Sendable {
    public var title: String?
    public var artists: [String]?
    public var album: String?
    public var albumArtists: [String]?
    public var trackNumber: Int?
    public var discNumber: Int?
    public var description: String?

    public init() {}

    enum CodingKeys: String, CodingKey {
        case title, artists, album, description
        case albumArtists = "album_artists"
        case trackNumber = "track_number"
        case discNumber = "disc_number"
    }
}

public struct ManagedLyrics: Decodable, Equatable, Sendable {
    public let trackID: String
    public let version: Int
    public let fileVersion: String
    public let override: String?
    public let observedText: String
    public let text: String

    enum CodingKeys: String, CodingKey {
        case version, override, text
        case trackID = "track_id"
        case fileVersion = "file_version"
        case observedText = "observed_text"
    }
}

extension WildstringClient {
    // MARK: - Library maintenance records

    public func scans(limit: Int = 20) async throws -> [ScanRecord] {
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/scans",
                queryItems: [URLQueryItem(name: "limit", value: String(limit))]
            )
        )
        return try JSONDecoder().decode([ScanRecord].self, from: data)
    }

    public func scan(id: String) async throws -> ScanRecord {
        let data = try await perform(Request(method: "GET", path: "api/v1/scans/\(id)"))
        return try JSONDecoder().decode(ScanRecord.self, from: data)
    }

    public func imports(limit: Int = 20) async throws -> [ImportRecord] {
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/imports",
                queryItems: [URLQueryItem(name: "limit", value: String(limit))]
            )
        )
        return try JSONDecoder().decode([ImportRecord].self, from: data)
    }

    // MARK: - Metadata editing

    public func manageMetadata(trackID: String) async throws -> ManagedMetadata {
        let data = try await perform(
            Request(method: "GET", path: "api/v1/manage/tracks/\(trackID)/metadata")
        )
        return try JSONDecoder().decode(ManagedMetadata.self, from: data)
    }

    public func updateMetadata(
        trackID: String,
        version: Int,
        overrides: MetadataOverrides
    ) async throws -> ManagedMetadata {
        struct Body: Encodable {
            let version: Int
            let overrides: MetadataOverrides
        }
        let data = try await perform(
            Request(
                method: "PUT",
                path: "api/v1/manage/tracks/\(trackID)/metadata",
                body: try JSONEncoder().encode(Body(version: version, overrides: overrides)),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(ManagedMetadata.self, from: data)
    }

    // MARK: - Lyrics editing

    public func managedLyrics(trackID: String) async throws -> ManagedLyrics {
        let data = try await perform(
            Request(method: "GET", path: "api/v1/manage/tracks/\(trackID)/lyrics")
        )
        return try JSONDecoder().decode(ManagedLyrics.self, from: data)
    }

    /// `text` nil restores the file lyrics; empty string hides lyrics.
    public func saveLyrics(
        trackID: String,
        text: String?,
        version: Int,
        fileVersion: String
    ) async throws -> ManagedLyrics {
        struct Body: Encodable {
            let version: Int
            let fileVersion: String
            let text: String?

            enum CodingKeys: String, CodingKey {
                case version, text
                case fileVersion = "file_version"
            }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(version, forKey: .version)
                try container.encode(fileVersion, forKey: .fileVersion)
                if let text {
                    try container.encode(text, forKey: .text)
                } else {
                    try container.encodeNil(forKey: .text)
                }
            }
        }
        let data = try await perform(
            Request(
                method: "PUT",
                path: "api/v1/manage/tracks/\(trackID)/lyrics",
                body: try JSONEncoder().encode(
                    Body(version: version, fileVersion: fileVersion, text: text)
                ),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(ManagedLyrics.self, from: data)
    }
}
