import Foundation

public struct AssistantMessage: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let role: String
    public let content: String
    public let partial: Bool?
    public let sources: [AssistantSource]?
    public let runID: String?

    enum CodingKeys: String, CodingKey {
        case id, role, content, partial, sources
        case runID = "run_id"
    }

    public var isUser: Bool { role == "user" }
}

public struct AssistantSource: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let url: String
}

public struct AssistantRun: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let status: String
    public let stage: String?
    public let errorCode: String?
    public let connectionID: String?
    public let draftIDs: [String]

    enum CodingKeys: String, CodingKey {
        case id, status, stage
        case errorCode = "error_code"
        case connectionID = "connection_id"
        case draftIDs = "draft_ids"
    }
}

public struct AssistantConnection: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let model: String
    public let enabled: Bool
    public let dailyCallsRemaining: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, model, enabled
        case dailyCallsRemaining = "daily_calls_remaining"
    }
}

public struct ConversationSummary: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let connectionId: String?

    enum CodingKeys: String, CodingKey {
        case id, title
        case connectionId = "connection_id"
    }
}

public struct ConversationDetail: Decodable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let messages: [AssistantMessage]
    public let connectionID: String?
    public let runs: [AssistantRun]?

    enum CodingKeys: String, CodingKey {
        case id, title, messages, runs
        case connectionID = "connection_id"
    }
}

public struct DraftEvidence: Decodable, Equatable, Sendable {
    public let source: String
    public let summary: String
    public let url: String?
}

public struct DraftPayload: Decodable, Equatable, Sendable {
    public let name: String?
    public let trackIds: [String]?
    public let playlistID: String?

    enum CodingKeys: String, CodingKey {
        case name
        case trackIds = "track_ids"
        case playlistID = "playlist_id"
    }
}

public struct DraftResult: Decodable, Equatable, Sendable {
    public let playlistId: String?

    enum CodingKeys: String, CodingKey {
        case playlistId = "playlist_id"
    }
}

public struct Draft: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let title: String
    public let status: String
    public let version: Int
    public let approvedVersion: Int?
    public let payload: DraftPayload?
    public let evidence: [DraftEvidence]
    public let result: DraftResult?
    public let previewDigest: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, title, status, version, payload, evidence, result
        case approvedVersion = "approved_version"
        case previewDigest = "preview_digest"
    }

    public var isPending: Bool { status == "pending" }
    public var isApproved: Bool { status == "approved" }
    public var isApplied: Bool { status == "applied" }
}

extension WildstringClient {
    // MARK: - Conversations

    public func assistantConnections(limit: Int = 100, offset: Int = 0) async throws
        -> Page<AssistantConnection>
    {
        let data = try await perform(
            Request(
                method: "GET", path: "api/v1/agent/connections",
                queryItems: [
                    URLQueryItem(name: "limit", value: String(limit)),
                    URLQueryItem(name: "offset", value: String(offset)),
                ]
            ))
        return try JSONDecoder().decode(Page<AssistantConnection>.self, from: data)
    }

    public func conversations(limit: Int = 50, offset: Int = 0) async throws
        -> Page<ConversationSummary>
    {
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/agent/conversations",
                queryItems: [
                    URLQueryItem(name: "limit", value: String(limit)),
                    URLQueryItem(name: "offset", value: String(offset)),
                ]
            )
        )
        return try JSONDecoder().decode(Page<ConversationSummary>.self, from: data)
    }

    public func conversation(id: String) async throws -> ConversationDetail {
        let data = try await perform(
            Request(method: "GET", path: "api/v1/agent/conversations/\(id)")
        )
        return try JSONDecoder().decode(ConversationDetail.self, from: data)
    }

    public func createConversation(
        title: String = "新对话", connectionID: String? = nil
    ) async throws -> ConversationDetail {
        struct Body: Encodable {
            let title: String
            let connectionID: String?

            enum CodingKeys: String, CodingKey {
                case title
                case connectionID = "connection_id"
            }
        }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/conversations",
                body: try JSONEncoder().encode(Body(title: title, connectionID: connectionID)),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(ConversationDetail.self, from: data)
    }

    public func renameConversation(id: String, title: String) async throws -> ConversationDetail {
        struct Body: Encodable { let title: String }
        let data = try await perform(
            Request(
                method: "PATCH", path: "api/v1/agent/conversations/\(id)",
                body: try JSONEncoder().encode(Body(title: title)), contentType: "application/json"
            ))
        return try JSONDecoder().decode(ConversationDetail.self, from: data)
    }

    public func deleteConversation(id: String) async throws {
        _ = try await perform(Request(method: "DELETE", path: "api/v1/agent/conversations/\(id)"))
    }

    public func sendMessage(
        conversationID: String,
        content: String,
        connectionID: String? = nil,
        maxCalls: Int? = nil
    ) async throws -> ConversationDetail {
        struct Body: Encodable {
            let content: String
            let connectionID: String?
            let maxCalls: Int?

            enum CodingKeys: String, CodingKey {
                case content
                case connectionID = "connection_id"
                case maxCalls = "max_calls"
            }
        }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/conversations/\(conversationID)/messages",
                body: try JSONEncoder().encode(
                    Body(
                        content: content, connectionID: connectionID, maxCalls: maxCalls
                    )),
                contentType: "application/json",
                timeout: 180
            )
        )
        return try JSONDecoder().decode(ConversationDetail.self, from: data)
    }

    // MARK: - Drafts

    public func drafts(
        limit: Int = 50,
        offset: Int = 0,
        status: String? = nil
    ) async throws -> Page<Draft> {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
        ]
        if let status, !status.isEmpty {
            queryItems.append(URLQueryItem(name: "status", value: status))
        }
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/agent/drafts",
                queryItems: queryItems
            )
        )
        return try JSONDecoder().decode(Page<Draft>.self, from: data)
    }

    public func draft(id: String) async throws -> Draft {
        let data = try await perform(Request(method: "GET", path: "api/v1/agent/drafts/\(id)"))
        return try JSONDecoder().decode(Draft.self, from: data)
    }

    public func approveDraft(id: String, version: Int) async throws -> Draft {
        struct Body: Encodable { let version: Int }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/drafts/\(id)/approve",
                body: try JSONEncoder().encode(Body(version: version)),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(Draft.self, from: data)
    }

    public func rejectDraft(id: String, version: Int) async throws -> Draft {
        struct Body: Encodable { let version: Int }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/drafts/\(id)/reject",
                body: try JSONEncoder().encode(Body(version: version)),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(Draft.self, from: data)
    }

    public func applyDraft(
        id: String,
        version: Int,
        idempotencyKey: String = "ios-" + UUID().uuidString.lowercased()
    ) async throws -> Draft {
        struct Body: Encodable {
            let version: Int
            let idempotencyKey: String

            enum CodingKeys: String, CodingKey {
                case version
                case idempotencyKey = "idempotency_key"
            }
        }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/drafts/\(id)/apply",
                body: try JSONEncoder().encode(
                    Body(version: version, idempotencyKey: idempotencyKey)
                ),
                contentType: "application/json",
                timeout: 60
            )
        )
        return try JSONDecoder().decode(Draft.self, from: data)
    }
}
