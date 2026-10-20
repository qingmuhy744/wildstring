import Foundation

public struct AppNotification: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let eventType: String?
    public let title: String
    public let summary: String
    public let severity: String?
    public let taskID: String?
    public let draftID: String?
    public let traceID: String?
    public let createdAt: String
    public let readAt: String?
    public let detailRoute: String?

    public init(
        id: String,
        eventType: String?,
        title: String,
        summary: String,
        severity: String?,
        taskID: String?,
        draftID: String?,
        traceID: String?,
        createdAt: String,
        readAt: String?,
        detailRoute: String?
    ) {
        self.id = id
        self.eventType = eventType
        self.title = title
        self.summary = summary
        self.severity = severity
        self.taskID = taskID
        self.draftID = draftID
        self.traceID = traceID
        self.createdAt = createdAt
        self.readAt = readAt
        self.detailRoute = detailRoute
    }

    enum CodingKeys: String, CodingKey {
        case id, title, summary, severity
        case eventType = "event_type"
        case taskID = "task_id"
        case draftID = "draft_id"
        case traceID = "trace_id"
        case createdAt = "created_at"
        case readAt = "read_at"
        case detailRoute = "detail_route"
    }

    public var isUnread: Bool { readAt == nil }
}

public struct NotificationPage: Decodable, Equatable, Sendable {
    public let items: [AppNotification]
    public let total: Int
    public let limit: Int
    public let offset: Int
    public let nextCursor: String?
    public let unreadCount: Int
    public let highWatermark: Int

    enum CodingKeys: String, CodingKey {
        case items, total, limit, offset
        case nextCursor = "next_cursor"
        case unreadCount = "unread_count"
        case highWatermark = "high_watermark"
    }
}

extension WildstringClient {
    public func notifications(limit: Int = 50, offset: Int = 0) async throws -> NotificationPage {
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/agent/notifications",
                queryItems: [
                    URLQueryItem(name: "limit", value: String(limit)),
                    URLQueryItem(name: "offset", value: String(offset)),
                ]
            )
        )
        return try JSONDecoder().decode(NotificationPage.self, from: data)
    }

    public func markNotificationsRead(ids: [String]) async throws {
        struct Body: Encodable { let ids: [String] }
        _ = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/notifications/read",
                body: try JSONEncoder().encode(Body(ids: ids)),
                contentType: "application/json"
            )
        )
    }

    public func markAllNotificationsRead(highWatermark: Int) async throws {
        struct Body: Encodable {
            let highWatermark: Int
            enum CodingKeys: String, CodingKey { case highWatermark = "high_watermark" }
        }
        _ = try await perform(
            Request(
                method: "POST",
                path: "api/v1/agent/notifications/read-all",
                body: try JSONEncoder().encode(Body(highWatermark: highWatermark)),
                contentType: "application/json"
            )
        )
    }
}
