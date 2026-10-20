import Foundation

/// Flexible metadata value used by review projections: strings, number/date
/// values, name lists and nested objects such as external IDs.
public indirect enum MetadataValue: Decodable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case list([MetadataValue])
    case object([String: MetadataValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode([MetadataValue].self) {
            self = .list(value)
        } else if let value = try? container.decode([String: MetadataValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.typeMismatch(
                MetadataValue.self,
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "Unsupported metadata value"
                )
            )
        }
    }

    public var display: String {
        switch self {
        case .string(let value): value
        case .number(let value):
            value.rounded() == value ? String(Int(value)) : String(value)
        case .bool(let value): value ? "是" : "否"
        case .list(let values):
            values.map(\.display).filter { !$0.isEmpty }.joined(separator: "、")
        case .object(let values):
            values.keys.sorted().map { "\($0)：\(values[$0]?.display ?? "")" }
                .joined(separator: "；")
        case .null: "—"
        }
    }
}

public struct ReviewAlbum: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let artists: [String]
    public let count: Int
}

public struct ReviewAlbumPage: Decodable, Sendable {
    public let items: [ReviewAlbum]
    public let total: Int
    public let limit: Int
    public let offset: Int
}

public struct ReviewCandidate: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let trackID: String
    public let metadataVersion: Int
    public let provider: String
    public let coverURL: String?
    public let fields: [String: MetadataValue]
    public let match: MetadataMatch?
    public let sourceURL: String?
    public let candidateDigest: String
    public let duplicateCount: Int?

    enum CodingKeys: String, CodingKey {
        case id, provider, fields, match
        case trackID = "track_id"
        case metadataVersion = "metadata_version"
        case coverURL = "cover_url"
        case sourceURL = "source_url"
        case candidateDigest = "candidate_digest"
        case duplicateCount = "duplicate_count"
    }
}

public struct ReviewTrack: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let album: String?
    public let albumID: String?
    public let artists: [String]
    public let discNumber: Int?
    public let trackNumber: Int?
    public let hasCover: Bool
    public let metadataVersion: Int
    public let current: [String: MetadataValue]
    public let original: [String: MetadataValue]
    public let overrides: [String: MetadataValue]
    public let suggestions: [ReviewCandidate]

    enum CodingKeys: String, CodingKey {
        case id, title, album, artists, current, original, overrides, suggestions
        case albumID = "album_id"
        case discNumber = "disc_number"
        case trackNumber = "track_number"
        case hasCover = "has_cover"
        case metadataVersion = "metadata_version"
    }
}

public struct ReviewPage: Decodable, Sendable {
    public let items: [ReviewTrack]
    public let total: Int
    public let limit: Int
    public let offset: Int
    public let albumID: String?
    public let providerNames: [String: String]

    enum CodingKeys: String, CodingKey {
        case items, total, limit, offset
        case albumID = "album_id"
        case providerNames = "provider_names"
    }
}

public struct ReviewConflict: Decodable, Equatable, Sendable {
    public let trackID: String
    public let title: String
    public let errorCode: String

    enum CodingKeys: String, CodingKey {
        case title
        case trackID = "track_id"
        case errorCode = "error_code"
    }
}

public struct ReviewAcceptResult: Decodable, Equatable, Sendable {
    public let status: String
    public let conflicts: [ReviewConflict]?
    public let draft: Draft?
}

public struct ReviewAcceptItem: Encodable, Sendable {
    public let trackID: String
    public let suggestionID: String
    public let metadataVersion: Int
    public let candidateDigest: String
    public let fields: [String]

    public init(
        trackID: String,
        suggestionID: String,
        metadataVersion: Int,
        candidateDigest: String,
        fields: [String]
    ) {
        self.trackID = trackID
        self.suggestionID = suggestionID
        self.metadataVersion = metadataVersion
        self.candidateDigest = candidateDigest
        self.fields = fields
    }

    enum CodingKeys: String, CodingKey {
        case fields
        case trackID = "track_id"
        case suggestionID = "suggestion_id"
        case metadataVersion = "metadata_version"
        case candidateDigest = "candidate_digest"
    }
}

public struct ReviewRejectResult: Decodable, Equatable, Sendable {
    public let status: String
    public let ignoredCount: Int
    public let alreadyIgnored: Bool

    enum CodingKeys: String, CodingKey {
        case status
        case ignoredCount = "ignored_count"
        case alreadyIgnored = "already_ignored"
    }
}

public struct ApplicationPolicy: Decodable, Equatable, Sendable {
    public let mode: String
    public let kinds: [String]
    public let version: Int
    public let allowedKinds: [String]

    enum CodingKeys: String, CodingKey {
        case mode, kinds, version
        case allowedKinds = "allowed_kinds"
    }
}

public struct ReviewCoverTarget: Encodable, Sendable {
    public let trackID: String
    public let metadataVersion: Int

    public init(trackID: String, metadataVersion: Int) {
        self.trackID = trackID
        self.metadataVersion = metadataVersion
    }

    enum CodingKeys: String, CodingKey {
        case trackID = "track_id"
        case metadataVersion = "metadata_version"
    }
}

extension WildstringClient {
    // MARK: - Review workbench

    public func reviewAlbums(limit: Int = 100, offset: Int = 0) async throws -> ReviewAlbumPage {
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/agent/metadata-review/albums",
                queryItems: [
                    URLQueryItem(name: "limit", value: String(limit)),
                    URLQueryItem(name: "offset", value: String(offset)),
                ]
            )
        )
        return try JSONDecoder().decode(ReviewAlbumPage.self, from: data)
    }

    public func metadataReview(
        albumID: String? = nil,
        trackID: String? = nil,
        limit: Int = 500,
        offset: Int = 0
    ) async throws -> ReviewPage {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
        ]
        if let albumID {
            queryItems.append(URLQueryItem(name: "album_id", value: albumID))
        }
        if let trackID {
            queryItems.append(URLQueryItem(name: "track_id", value: trackID))
        }
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/agent/metadata-review",
                queryItems: queryItems
            )
        )
        return try JSONDecoder().decode(ReviewPage.self, from: data)
    }

    public func acceptReview(
        items: [ReviewAcceptItem],
        coverDraftID: String? = nil,
        idempotencyKey: String
    ) async throws -> ReviewAcceptResult {
        struct Body: Encodable {
            let items: [ReviewAcceptItem]
            let coverDraftID: String?
            let idempotencyKey: String

            enum CodingKeys: String, CodingKey {
                case items
                case coverDraftID = "cover_draft_id"
                case idempotencyKey = "idempotency_key"
            }
        }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/metadata-review/accept",
                body: try JSONEncoder().encode(
                    Body(items: items, coverDraftID: coverDraftID, idempotencyKey: idempotencyKey)
                ),
                contentType: "application/json",
                timeout: 120
            )
        )
        return try JSONDecoder().decode(ReviewAcceptResult.self, from: data)
    }

    /// Requires a 0.5.12+ server; older servers return 404/405.
    public func rejectReview(
        trackID: String,
        suggestionID: String,
        metadataVersion: Int,
        candidateDigest: String
    ) async throws -> ReviewRejectResult {
        struct Body: Encodable {
            let trackID: String
            let suggestionID: String
            let metadataVersion: Int
            let candidateDigest: String

            enum CodingKeys: String, CodingKey {
                case trackID = "track_id"
                case suggestionID = "suggestion_id"
                case metadataVersion = "metadata_version"
                case candidateDigest = "candidate_digest"
            }
        }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/metadata-review/reject",
                body: try JSONEncoder().encode(
                    Body(
                        trackID: trackID,
                        suggestionID: suggestionID,
                        metadataVersion: metadataVersion,
                        candidateDigest: candidateDigest
                    )
                ),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(ReviewRejectResult.self, from: data)
    }

    /// Freezes one candidate cover into a server-owned snapshot draft.
    public func reviewCoverDraft(
        title: String,
        suggestionID: String,
        metadataVersion: Int,
        targets: [ReviewCoverTarget]
    ) async throws -> Draft {
        struct Payload: Encodable {
            let suggestionID: String
            let metadataVersion: Int
            let targets: [ReviewCoverTarget]

            enum CodingKeys: String, CodingKey {
                case suggestionID = "suggestion_id"
                case metadataVersion = "metadata_version"
                case targets
            }
        }
        struct Body: Encodable {
            let kind: String
            let title: String
            let payload: Payload
        }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/metadata-review/cover",
                body: try JSONEncoder().encode(
                    Body(
                        kind: "cover",
                        title: title,
                        payload: Payload(
                            suggestionID: suggestionID,
                            metadataVersion: metadataVersion,
                            targets: targets
                        )
                    )
                ),
                contentType: "application/json",
                timeout: 120
            )
        )
        return try JSONDecoder().decode(Draft.self, from: data)
    }

    public func draftCoverPreview(id: String) async throws -> Data {
        try await authorizedData(path: "api/v1/agent/drafts/\(id)/cover-preview")
    }

    public func acceptDraft(
        id: String,
        version: Int,
        previewDigest: String?,
        idempotencyKey: String = "ios-" + UUID().uuidString.lowercased()
    ) async throws -> Draft {
        struct Body: Encodable {
            let version: Int
            let previewDigest: String?
            let idempotencyKey: String

            enum CodingKeys: String, CodingKey {
                case version
                case previewDigest = "preview_digest"
                case idempotencyKey = "idempotency_key"
            }
        }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/drafts/\(id)/accept",
                body: try JSONEncoder().encode(
                    Body(
                        version: version,
                        previewDigest: previewDigest,
                        idempotencyKey: idempotencyKey
                    )
                ),
                contentType: "application/json",
                timeout: 120
            )
        )
        return try JSONDecoder().decode(Draft.self, from: data)
    }

    // MARK: - Application policy

    public func applicationPolicy() async throws -> ApplicationPolicy {
        let data = try await perform(
            Request(method: "GET", path: "api/v1/agent/application-policy")
        )
        return try JSONDecoder().decode(ApplicationPolicy.self, from: data)
    }

    public func saveApplicationPolicy(
        mode: String,
        kinds: [String],
        version: Int
    ) async throws -> ApplicationPolicy {
        struct Body: Encodable {
            let mode: String
            let kinds: [String]
            let version: Int
        }
        let data = try await perform(
            Request(
                method: "PUT",
                path: "api/v1/agent/application-policy",
                body: try JSONEncoder().encode(Body(mode: mode, kinds: kinds, version: version)),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(ApplicationPolicy.self, from: data)
    }
}
