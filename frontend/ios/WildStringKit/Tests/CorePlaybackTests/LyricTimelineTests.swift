import CoreNetwork
import Testing
@testable import CorePlayback

@Suite("LyricTimeline")
struct LyricTimelineTests {
    private func timeline(kind: String, ms: [Int64?], texts: [String]) -> LyricTimeline {
        LyricTimeline(
            lyrics: Lyrics(
                kind: kind,
                lines: zip(ms, texts).map { LyricLine(timeMs: $0.0, text: $0.1) }
            )
        )
    }

    @Test func syncedHighlightFollowsTime() {
        let timeline = timeline(
            kind: "synced",
            ms: [0, 4_000, 8_000],
            texts: ["第一行", "第二行", "第三行"]
        )
        #expect(timeline.isSynced)
        #expect(timeline.currentIndex(at: 0) == 0)
        #expect(timeline.currentIndex(at: 3.9) == 0)
        #expect(timeline.currentIndex(at: 4) == 1)
        #expect(timeline.currentIndex(at: 7.9) == 1)
        #expect(timeline.currentIndex(at: 8) == 2)
        #expect(timeline.currentIndex(at: 100) == 2)
    }

    @Test func syncedBeforeFirstLineHighlightsFirstTimedLine() {
        let timeline = timeline(kind: "synced", ms: [10_000], texts: ["晚开始"])
        #expect(timeline.currentIndex(at: 0) == 0)
        #expect(timeline.currentIndex(at: 9.9) == 0)
        #expect(timeline.currentIndex(at: 10.1) == 0)
    }

    @Test func plainLyricsHaveNoHighlight() {
        let timeline = timeline(kind: "plain", ms: [nil, nil], texts: ["甲", "乙"])
        #expect(!timeline.isSynced)
        #expect(timeline.currentIndex(at: 12) == nil)
        #expect(!timeline.isEmpty)
    }

    @Test func noneIsEmpty() {
        let timeline = timeline(kind: "none", ms: [], texts: [])
        #expect(timeline.isEmpty)
    }
}
