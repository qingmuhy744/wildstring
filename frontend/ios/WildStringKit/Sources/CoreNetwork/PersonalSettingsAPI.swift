import Foundation

public struct RecommendationPreferences: Codable, Sendable {
    public let version: Int
    public var useAi: Bool
    public var useLastfm: Bool
    public var count: Int
    public var connectionId: String?
    public var sources: [String]
    public var lastfmTags: [String]
    public var externalEnabled: Bool
    public var externalRefreshDays: Int
    public var externalSources: [String]
    public var externalUseAi: Bool
    public var externalCallLimit: Int
    public var dailyEnabled: Bool
    public var dailyTime: String
}

public struct ExternalRecommendation: Decodable, Sendable, Identifiable {
    public let externalId: String
    public let name: String
    public let artists: [String]
    public let sourceUrl: URL?
    public let reason: String
    public let localTrack: Track?
    public let wanted: Bool
    public var id: String { externalId }

    enum CodingKeys: String, CodingKey {
        case name, artists, reason, wanted
        case externalId = "external_id"
        case sourceUrl = "source_url"
        case localTrack = "local_track"
    }
}

public struct ExternalRecommendations: Decodable, Sendable {
    public let items: [ExternalRecommendation]
    public let status: String
    public let stale: Bool
    public let degraded: Bool
}

public struct LastfmAccount: Decodable, Sendable {
    public let configured: Bool
    public let connected: Bool
    public let username: String?
    public let scrobble: Bool
    public let nowPlaying: Bool
    public let needsAuth: Bool?
    public let version: Int
}

public struct PersonalNotificationPreferences: Codable, Sendable {
    public var telegramEnabled: Bool
    public var eventTypes: [String]
    public var minSeverity: String
    public var quietStart: String?
    public var quietEnd: String?
    public var timezone: String
}

extension WildstringClient {
    private func personalDecode<Result: Decodable>(_ data: Data) throws -> Result {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(Result.self, from: data)
    }

    private func personalGet<Result: Decodable>(_ path: String) async throws -> Result {
        try await personalDecode(consumerAction("GET", path))
    }

    private func personalSave<Body: Encodable, Result: Decodable>(_ path: String, _ value: Body) async throws -> Result {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        let data = try await perform(Request(
            method: "PUT", path: "api/v1/" + path, body: try encoder.encode(value), contentType: "application/json"
        ))
        return try personalDecode(data)
    }

    public func recommendationPreferences() async throws -> RecommendationPreferences {
        try await personalGet("recommendations/preferences")
    }

    public func saveRecommendationPreferences(_ value: RecommendationPreferences) async throws -> RecommendationPreferences {
        try await personalSave("recommendations/preferences", value)
    }

    public func externalRecommendations(refresh: Bool = false) async throws -> ExternalRecommendations {
        if !refresh { return try await consumerGet("recommendations/external") }
        let data = try await consumerWrite("POST", "recommendations/external/refresh", [String: String]())
        return try JSONDecoder().decode(ExternalRecommendations.self, from: data)
    }

    public func externalRecommendationFeedback(id: String, action: String) async throws {
        try await consumerWrite("POST", "recommendations/external/feedback", ["external_id": id, "action": action])
    }

    public func updateProfile(_ user: User, displayName: String, email: String) async throws -> User {
        struct Body: Encodable {
            let version: Int
            let username: String
            let display_name: String
            let email: String
        }
        let body = Body(version: user.version, username: user.username, display_name: displayName, email: email)
        let data = try await consumerWrite("PUT", "auth/profile", body)
        return try JSONDecoder().decode(User.self, from: data)
    }

    public func changePassword(current: String, new: String) async throws {
        try await consumerWrite("POST", "auth/password", ["current_password": current, "new_password": new])
    }

    public func avatarImage(accountID: String) async throws -> Data? {
        do {
            return try await perform(Request(method: "GET", path: "api/v1/auth/avatar", queryItems: [
                URLQueryItem(name: "account", value: accountID)
            ]))
        } catch let error as APIError where error.code == "avatar_not_found" {
            return nil
        }
    }

    public func saveAvatar(_ data: Data?, accountID: String) async throws {
        _ = try await perform(Request(
            method: data == nil ? "DELETE" : "POST", path: "api/v1/auth/avatar",
            body: data, contentType: data == nil ? nil : "image/jpeg",
            queryItems: [URLQueryItem(name: "account", value: accountID)]
        ))
    }

    public func lastfmAccount() async throws -> LastfmAccount {
        try await personalGet("lastfm")
    }

    public func authorizeLastfm() async throws -> URL {
        struct Response: Decodable { let url: URL }
        let data = try await consumerAction("POST", "lastfm/authorize")
        return try JSONDecoder().decode(Response.self, from: data).url
    }

    public func saveLastfmAccount(_ account: LastfmAccount, scrobble: Bool, nowPlaying: Bool) async throws -> LastfmAccount {
        struct Body: Encodable {
            let version: Int
            let scrobble: Bool
            let nowPlaying: Bool
        }
        return try await personalSave("lastfm", Body(version: account.version, scrobble: scrobble, nowPlaying: nowPlaying))
    }

    public func disconnectLastfm() async throws {
        try await consumerAction("DELETE", "lastfm")
    }

    public func notificationPreferences() async throws -> PersonalNotificationPreferences {
        try await personalGet("agent/notification-preferences")
    }

    public func saveNotificationPreferences(_ value: PersonalNotificationPreferences) async throws -> PersonalNotificationPreferences {
        // Null clears an existing quiet-hours boundary on the server.
        try await personalSave("agent/notification-preferences", value)
    }
}
