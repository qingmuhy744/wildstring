import Foundation

public struct AssistantMessage: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let role: String
    public let content: String
    public let partial: Bool?

    public var isUser: Bool { role == "user" }
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
}

public struct DraftEvidence: Decodable, Equatable, Sendable {
    public let source: String
    public let summary: String
    public let url: String?
}

public struct DraftPayload: Decodable, Equatable, Sendable {
    public let name: String?
    public let trackIds: [String]?

    enum CodingKeys: String, CodingKey {
        case name
        case trackIds = "track_ids"
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

    enum CodingKeys: String, CodingKey {
        case id, kind, title, status, version, payload, evidence, result
        case approvedVersion = "approved_version"
    }

    public var isPending: Bool { status == "pending" }
    public var isApproved: Bool { status == "approved" }
    public var isApplied: Bool { status == "applied" }
}

extension WildstringClient {
    // MARK: - Conversations

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

    public func createConversation(title: String = "新对话") async throws -> ConversationDetail {
        struct Body: Encodable { let title: String }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/conversations",
                body: try JSONEncoder().encode(Body(title: title)),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(ConversationDetail.self, from: data)
    }

    public func sendMessage(
        conversationID: String,
        content: String,
        maxCalls: Int = 4
    ) async throws -> ConversationDetail {
        struct Body: Encodable {
            let content: String
            let maxCalls: Int

            enum CodingKeys: String, CodingKey {
                case content
                case maxCalls = "max_calls"
            }
        }
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/conversations/\(conversationID)/messages",
                body: try JSONEncoder().encode(Body(content: content, maxCalls: maxCalls)),
                contentType: "application/json",
                timeout: 120
            )
        )
        return try JSONDecoder().decode(ConversationDetail.self, from: data)
    }

    // MARK: - Drafts

    public func drafts(limit: Int = 50, offset: Int = 0) async throws -> Page<Draft> {
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/agent/drafts",
                queryItems: [
                    URLQueryItem(name: "limit", value: String(limit)),
                    URLQueryItem(name: "offset", value: String(offset)),
                ]
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
