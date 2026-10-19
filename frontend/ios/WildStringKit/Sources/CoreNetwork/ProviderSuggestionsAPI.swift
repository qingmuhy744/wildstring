import Foundation

/// A value in a provider suggestion: plain text, a list of names or a number.
public enum MetadataFieldValue: Decodable, Equatable, Sendable {
    case text(String)
    case list([String])
    case number(Int)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .text(value)
        } else if let value = try? container.decode([String].self) {
            self = .list(value)
        } else if let value = try? container.decode(Int.self) {
            self = .number(value)
        } else {
            throw DecodingError.typeMismatch(
                MetadataFieldValue.self,
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "Unsupported metadata field value"
                )
            )
        }
    }

    public var display: String {
        switch self {
        case .text(let value): value
        case .list(let values): values.joined(separator: "、")
        case .number(let value): String(value)
        }
    }
}

public struct MetadataMatch: Decodable, Equatable, Sendable {
    public let method: String?
    public let score: Double?
}

public struct ProviderSuggestion: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let provider: String
    public let status: String
    public let metadataVersion: Int
    public let fields: [String: MetadataFieldValue]
    public let coverURL: String?
    public let sourceURL: String?
    public let match: MetadataMatch?

    enum CodingKeys: String, CodingKey {
        case id, provider, status, fields, match
        case metadataVersion = "metadata_version"
        case coverURL = "cover_url"
        case sourceURL = "source_url"
    }
}

public struct ProviderJob: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let status: String?
    public let error: String?
}

public struct ProviderSuggestions: Decodable, Equatable, Sendable {
    public let suggestions: [ProviderSuggestion]
    public let jobs: [ProviderJob]
    public let providerNames: [String: String]

    enum CodingKeys: String, CodingKey {
        case suggestions, jobs
        case providerNames = "provider_names"
    }
}

public struct ProviderRefreshResult: Decodable, Equatable, Sendable {
    public let queued: Int
    public let alreadyActive: Int
    public let total: Int

    enum CodingKeys: String, CodingKey {
        case queued, total
        case alreadyActive = "already_active"
    }
}

extension WildstringClient {
    /// Existing provider evidence for one track; nothing is applied by reading.
    public func providerSuggestions(trackID: String) async throws -> ProviderSuggestions {
        let data = try await perform(
            Request(method: "GET", path: "api/v1/manage/providers/tracks/\(trackID)")
        )
        return try JSONDecoder().decode(ProviderSuggestions.self, from: data)
    }

    /// Queues a bounded public-source lookup; suggestions appear later.
    public func refreshProviderMetadata(
        trackID: String,
        mode: String,
        force: Bool
    ) async throws -> ProviderRefreshResult {
        struct Body: Encodable {
            let scope: String
            let id: String
            let mode: String
            let force: Bool
        }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/manage/providers/refresh",
                body: try JSONEncoder().encode(
                    Body(scope: "track", id: trackID, mode: mode, force: force)
                ),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(ProviderRefreshResult.self, from: data)
    }

    /// Applies only the chosen fields; 409 means the metadata changed first.
    @discardableResult
    public func applyProviderSuggestion(
        id: String,
        version: Int,
        fields: [String]
    ) async throws -> ManagedMetadata {
        struct Body: Encodable {
            let version: Int
            let fields: [String]
        }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/manage/providers/suggestions/\(id)/apply",
                body: try JSONEncoder().encode(Body(version: version, fields: fields)),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(ManagedMetadata.self, from: data)
    }

    /// Confirms one candidate cover after an explicit user choice.
    public func applyProviderCover(suggestionID: String, version: Int) async throws {
        struct Body: Encodable {
            let version: Int
        }
        _ = try await perform(
            Request(
                method: "POST",
                path: "api/v1/manage/providers/suggestions/\(suggestionID)/cover",
                body: try JSONEncoder().encode(Body(version: version)),
                contentType: "application/json"
            )
        )
    }

    /// Size-limited JPEG preview of a candidate cover, proxied by the server.
    public func providerCoverPreview(suggestionID: String) async throws -> Data {
        try await authorizedData(
            path: "api/v1/manage/providers/suggestions/\(suggestionID)/cover-preview"
        )
    }
}
