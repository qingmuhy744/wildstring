import Foundation

public struct ListeningReport: Equatable, Sendable, Encodable {
    public var sessionId: String
    public var trackId: String
    public var listenedMs: Int
    public var startedAt: Double
    public var state: String

    public init(
        sessionId: String,
        trackId: String,
        listenedMs: Int,
        startedAt: Double,
        state: String
    ) {
        self.sessionId = sessionId
        self.trackId = trackId
        self.listenedMs = listenedMs
        self.startedAt = startedAt
        self.state = state
    }

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case trackId = "track_id"
        case listenedMs = "listened_ms"
        case startedAt = "started_at"
        case state
    }
}

public struct PodcastProgressWrite: Equatable, Sendable, Encodable {
    public var sessionId: String
    public var deviceId: String
    public var baseVersion: Int
    public var sequence: Int
    public var positionSeconds: Int
    public var durationSeconds: Int
    public var event: String

    public init(
        sessionId: String,
        deviceId: String,
        baseVersion: Int,
        sequence: Int,
        positionSeconds: Int,
        durationSeconds: Int,
        event: String
    ) {
        self.sessionId = sessionId
        self.deviceId = deviceId
        self.baseVersion = baseVersion
        self.sequence = sequence
        self.positionSeconds = positionSeconds
        self.durationSeconds = durationSeconds
        self.event = event
    }

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case deviceId = "device_id"
        case baseVersion = "base_version"
        case sequence
        case positionSeconds = "position_seconds"
        case durationSeconds = "duration_seconds"
        case event
    }
}
