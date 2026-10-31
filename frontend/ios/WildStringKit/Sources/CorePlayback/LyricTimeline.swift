import CoreNetwork
import Foundation

/// Maps playback time to the highlighted lyric line.
public struct LyricTimeline: Equatable, Sendable {
    public struct Line: Equatable, Sendable {
        public let time: Double?
        public let text: String
        public let words: [Word]
        public let translation: String?
        public let romanization: String?
    }

    public struct Word: Equatable, Sendable {
        public let start: Double
        public let end: Double
        public let text: String

        public func progress(at time: Double) -> Double {
            if end <= start { return time >= start ? 1 : 0 }
            return min(1, max(0, (time - start) / (end - start)))
        }
    }

    public let lines: [Line]
    public let isSynced: Bool

    public init(lyrics: Lyrics) {
        isSynced = lyrics.kind == "synced" && lyrics.lines.contains { $0.timeMs != nil }
        lines = lyrics.lines.map { line in
            Line(
                time: line.timeMs.map { Double($0) / 1000 }, text: line.text,
                words: (line.words ?? []).map {
                    Word(start: Double($0.startMs) / 1000, end: Double($0.endMs) / 1000, text: $0.text)
                },
                translation: line.translation, romanization: line.romanization
            )
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
