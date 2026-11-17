import CoreNetwork
import Foundation

public enum PodcastSubmitResult: Equatable, Sendable {
    case ok
    case completed
    case conflict
    case conflictCurrent(PodcastProgressSnapshot)
    case failed
}

/// One listening session for a single episode. Sequence only increases.
/// A conflict stops further uploads until the user starts the episode again.
public struct PodcastBookmark: Codable, Sendable {
    public private(set) var episodeId = ""
    public private(set) var ready = false
    public private(set) var blocked = false
    public private(set) var sessionId = ""
    private var deviceId = ""
    public private(set) var baseVersion = 0
    public private(set) var intent = "resume"
    private(set) var sequence = 0
    private(set) var completedSequence: Int? = nil
    private var lastSentAt: Int64 = 0

    private enum CodingKeys: String, CodingKey {
        case episodeId, ready, blocked, sessionId, deviceId, baseVersion, intent, sequence, completedSequence
    }

    public init() {}

    public mutating func begin(episodeId: String, deviceId: String, baseVersion: Int, intent: String = "resume") {
        self.episodeId = episodeId
        self.deviceId = deviceId
        self.baseVersion = baseVersion
        self.intent = intent
        sessionId = UUID().uuidString
        sequence = 0
        completedSequence = nil
        lastSentAt = 0
        ready = true
        blocked = false
    }

    public mutating func clear() {
        ready = false
        blocked = false
        episodeId = ""
        sequence = 0
        sessionId = ""
        completedSequence = nil
    }

    public mutating func block() {
        blocked = true
    }

    mutating func acknowledgeCompletion(_ write: PodcastProgressWrite) {
        guard sessionId == write.sessionId, write.event == "ended" else { return }
        completedSequence = max(completedSequence ?? 0, write.sequence)
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
            event: event,
            intent: intent
        )
    }
}
