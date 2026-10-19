import Foundation

public struct PlaybackOutput: Decodable, Equatable, Sendable {
    public let codec: String
    public let container: String?
    public let bitrateKbps: Int?

    enum CodingKeys: String, CodingKey {
        case codec, container
        case bitrateKbps = "bitrate_kbps"
    }
}

public struct PlaybackPlan: Decodable, Equatable, Sendable {
    public let mode: String
    public let reason: String?
    public let durationMs: Int64?
    public let startMs: Int64?
    public let streamUrl: String
    public let output: PlaybackOutput
    public let cacheState: String?

    enum CodingKeys: String, CodingKey {
        case mode, reason, output
        case durationMs = "duration_ms"
        case startMs = "start_ms"
        case streamUrl = "stream_url"
        case cacheState = "cache_state"
    }

    public var isTranscode: Bool { mode == "transcode" }
}

extension WildstringClient {
    /// `GET /api/v1/tracks/{id}/playback`: original when bitrate is nil,
    /// otherwise an AAC decision starting at `startMs`.
    public func playbackPlan(
        trackID: String,
        bitrateKbps: Int?,
        startMs: Int64 = 0
    ) async throws -> PlaybackPlan {
        var queryItems: [URLQueryItem] = []
        if let bitrateKbps {
            queryItems.append(URLQueryItem(name: "format", value: "aac"))
            queryItems.append(URLQueryItem(name: "bitrate_kbps", value: String(bitrateKbps)))
        }
        if startMs > 0 {
            queryItems.append(URLQueryItem(name: "start_ms", value: String(startMs)))
        }
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/tracks/\(trackID)/playback",
                queryItems: queryItems,
                timeout: 30
            )
        )
        return try JSONDecoder().decode(PlaybackPlan.self, from: data)
    }
}
