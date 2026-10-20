import CoreNetwork
import Foundation

/// Maps playback time to the highlighted lyric line.
public struct LyricTimeline: Equatable, Sendable {
    public struct Line: Equatable, Sendable {
        public let time: Double?
        public let text: String
    }

    public let lines: [Line]
    public let isSynced: Bool

    public init(lyrics: Lyrics) {
        isSynced = lyrics.kind == "synced" && lyrics.lines.contains { $0.timeMs != nil }
        lines = lyrics.lines.map { line in
            Line(time: line.timeMs.map { Double($0) / 1000 }, text: line.text)
        }
    }

    public var isEmpty: Bool { lines.isEmpty }

    /// Highlighted line for the given playback position; nil for plain lyrics.
    public func currentIndex(at time: Double) -> Int? {
        guard isSynced, !lines.isEmpty else { return nil }
        var index: Int?
        for (position, line) in lines.enumerated() {
            guard let lineTime = line.time else { continue }
            if lineTime <= time {
                index = position
            } else {
                break
            }
        }
        return index ?? lines.firstIndex { $0.time != nil }
    }
}
