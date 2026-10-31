import CoreNetwork
import Foundation

public enum PodcastSubmitResult: Sendable {
    case ok
    case conflict
    case failed
}

/// One listening session for a single episode. Sequence only increases.
/// A conflict stops further uploads until the user starts the episode again.
public struct PodcastBookmark: Sendable {
    public private(set) var episodeId = ""
    public private(set) var ready = false
    public private(set) var blocked = false
    private var sessionId = ""
    private var deviceId = ""
    private var baseVersion = 0
    private var sequence = 0
    private var lastSentAt: Int64 = 0

    public init() {}

    public mutating func begin(episodeId: String, deviceId: String, baseVersion: Int) {
        self.episodeId = episodeId
        self.deviceId = deviceId
        self.baseVersion = baseVersion
        sessionId = UUID().uuidString
        sequence = 0
        lastSentAt = 0
        ready = true
        blocked = false
    }

    public mutating func clear() {
        ready = false
        blocked = false
        episodeId = ""
        sequence = 0
    }

    public mutating func block() {
        blocked = true
    }

    public mutating func next(
        positionSeconds: Int,
        durationSeconds: Int,
        event: String,
        nowMs: Int64,
        force: Bool
    ) -> PodcastProgressWrite? {
        guard ready, !blocked, !sessionId.isEmpty else { return nil }
        if !force, nowMs - lastSentAt < 10_000 { return nil }
        sequence += 1
        lastSentAt = nowMs
        let duration = max(0, durationSeconds)
        let position = duration > 0 ? min(max(0, positionSeconds), duration) : max(0, positionSeconds)
        return PodcastProgressWrite(
            sessionId: sessionId,
            deviceId: deviceId,
            baseVersion: baseVersion,
            sequence: sequence,
            positionSeconds: position,
            durationSeconds: duration,
            event: event
        )
    }
}
