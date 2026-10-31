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

    @Test func wordTimingKeepsLanguagesAndFollowsFractionalProgressAfterSeek() {
        let timeline = LyricTimeline(lyrics: Lyrics(kind: "synced", lines: [
            LyricLine(timeMs: 1_000, text: "甲乙", words: [
                LyricWord(startMs: 1_000, endMs: 1_500, text: "甲"),
                LyricWord(startMs: 1_500, endMs: 2_500, text: "乙")
            ], translation: "A B", romanization: "jia yi"),
            LyricLine(timeMs: 3_000, text: "下一行")
        ]))
        let line = timeline.lines[0]
        #expect(line.translation == "A B")
        #expect(line.romanization == "jia yi")
        #expect(line.words[0].start == 1)
        #expect(line.words[0].end == 1.5)
        #expect(line.words[0].progress(at: 0.8) == 0)
        #expect(line.words[0].progress(at: 1.25) == 0.5)
        #expect(line.words[0].progress(at: 3) == 1)
        #expect(line.words[1].progress(at: 2) == 0.5)
        #expect(timeline.currentIndex(at: 4) == 1)
        #expect(timeline.currentIndex(at: 1.25) == 0)
        #expect(line.words[1].progress(at: 1.25) == 0)
        #expect(timeline.lines[1].words.isEmpty)
    }

    @Test func zeroDurationWordSwitchesAtItsStart() {
        let timeline = LyricTimeline(lyrics: Lyrics(kind: "synced", lines: [
            LyricLine(timeMs: 1_000, text: "甲", words: [LyricWord(startMs: 1_000, endMs: 1_000, text: "甲")])
        ]))
        let word = timeline.lines[0].words[0]
        #expect(word.progress(at: 0.999) == 0)
        #expect(word.progress(at: 1) == 1)
    }
}
