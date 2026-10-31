import CoreNetwork
import Foundation

/// Counts actual media advancement, bounded by monotonic elapsed time.
/// Seeking and paused wall time do not add listening time.
public struct ListeningClock: Sendable {
    public private(set) var totalMs: Int64 = 0
    private var wall: Int64 = 0
    private var position: Int64 = 0
    private var wasPlaying = false

    public init() {}

    public mutating func reset(now: Int64, mediaPosition: Int64, playing: Bool) {
        wall = now
        position = mediaPosition
        wasPlaying = playing
    }

    /// Drops the in-flight interval and the seek jump, then continues from `mediaPosition`.
    public mutating func reanchor(now: Int64, mediaPosition: Int64, playing: Bool) {
        reset(now: now, mediaPosition: mediaPosition, playing: playing)
    }

    @discardableResult
    public mutating func sample(now: Int64, mediaPosition: Int64, playing: Bool) -> Int64 {
        if wasPlaying {
            let media = max(Int64(0), mediaPosition - position)
            let elapsed = max(Int64(0), now - wall)
            totalMs += min(media, elapsed)
        }
        reset(now: now, mediaPosition: mediaPosition, playing: playing)
        return totalMs
    }
}

/// One music play uses one session id and a cumulative listened total.
/// Podcast episode ids are ignored so they do not become play counts.
public struct ListeningTracker: Sendable {
    public private(set) var clock = ListeningClock()
    public private(set) var trackId: String?
    private var sessionId: String?
    private var startedAt: Double = 0
    private var sentMs = 0
    private var active = false

    public init() {}

    public static func isPodcast(_ trackID: String?) -> Bool {
        trackID?.hasPrefix("podcast_ep_") == true
    }

    /// Ends the previous music session, then starts a new one unless this is a podcast episode.
    public mutating func begin(
        trackID: String?,
        nowMs: Int64,
        positionMs: Int64,
        playing: Bool,
        startedAt: Double
    ) -> ListeningReport? {
        let previous = flush(state: "paused", nowMs: nowMs, positionMs: positionMs)
        clock = ListeningClock()
        sentMs = 0
        guard let trackID, !Self.isPodcast(trackID) else {
            active = false
            sessionId = nil
            trackId = nil
            return previous
        }
        active = true
        sessionId = UUID().uuidString
        trackId = trackID
        self.startedAt = startedAt
        clock.reset(now: nowMs, mediaPosition: positionMs, playing: playing)
        return previous
    }

    public mutating func reanchor(nowMs: Int64, positionMs: Int64, playing: Bool) {
        guard active else { return }
        clock.reanchor(now: nowMs, mediaPosition: positionMs, playing: playing)
    }

    public mutating func sample(
        nowMs: Int64,
        positionMs: Int64,
        playing: Bool,
        state: String
    ) -> ListeningReport? {
        guard active else { return nil }
        clock.sample(now: nowMs, mediaPosition: positionMs, playing: playing)
        return reportIfNeeded(state: state, minimumGap: 5_000)
    }

    public mutating func flush(state: String, nowMs: Int64, positionMs: Int64) -> ListeningReport? {
        guard active else { return nil }
        clock.sample(now: nowMs, mediaPosition: positionMs, playing: false)
        return reportIfNeeded(state: state, minimumGap: 0)
    }

    /// A failed upload must retry the same cumulative total, not a new session.
    public mutating func reject(sessionId: String) {
        guard self.sessionId == sessionId else { return }
        sentMs = 0
    }

    private mutating func reportIfNeeded(state: String, minimumGap: Int) -> ListeningReport? {
        guard let sessionId, let trackId else { return nil }
        let value = Int(min(clock.totalMs, Int64(Int.max)))
        guard value > sentMs else { return nil }
        if minimumGap > 0, value - sentMs < minimumGap { return nil }
        sentMs = value
        return ListeningReport(
            sessionId: sessionId,
            trackId: trackId,
            listenedMs: min(value, 86_400_000),
            startedAt: startedAt,
            state: state
        )
    }
}
