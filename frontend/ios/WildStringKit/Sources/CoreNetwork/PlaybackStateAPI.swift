import Foundation

/// Cross-device playback snapshot (`/api/v1/playback/state`).
public struct RemotePlaybackState: Codable, Equatable, Sendable {
    public var version: Int
    public var deviceId: String
    public var trackIds: [String]
    public var index: Int
    public var positionMs: Int64
    public var mode: String

    public init(
        version: Int,
        deviceId: String,
        trackIds: [String],
        index: Int,
        positionMs: Int64,
        mode: String
    ) {
        self.version = version
        self.deviceId = deviceId
        self.trackIds = trackIds
        self.index = index
        self.positionMs = positionMs
        self.mode = mode
    }

    enum CodingKeys: String, CodingKey {
        case version, index, mode
        case deviceId = "device_id"
        case trackIds = "track_ids"
        case positionMs = "position_ms"
    }
}

extension WildstringClient {
    public func playbackState() async throws -> RemotePlaybackState {
        let data = try await perform(Request(method: "GET", path: "api/v1/playback/state"))
        return try JSONDecoder().decode(RemotePlaybackState.self, from: data)
    }

    /// Publishes a snapshot with optimistic versioning; 409 means another
    /// device saved first.
    public func savePlaybackState(_ state: RemotePlaybackState) async throws -> RemotePlaybackState {
        let data = try await perform(
            Request(
                method: "PUT",
                path: "api/v1/playback/state",
                body: try JSONEncoder().encode(state),
                contentType: "application/json"
            )
        )
        return try JSONDecoder().decode(RemotePlaybackState.self, from: data)
    }

    public func track(id: String) async throws -> Track {
        let data = try await perform(Request(method: "GET", path: "api/v1/tracks/\(id)"))
        return try JSONDecoder().decode(Track.self, from: data)
    }
}
