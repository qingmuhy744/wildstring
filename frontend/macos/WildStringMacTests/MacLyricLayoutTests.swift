import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI
import Testing
@testable import WildString

@Suite("Mac lyric layout", .serialized)
@MainActor
struct MacLyricLayoutTests {
    private let text = "这是一句需要完整展示并随窗口宽度自然折行的歌词"

    private func size(words: Bool, width: CGFloat) -> CGSize {
        let line = LyricTimeline(lyrics: Lyrics(kind: "synced", lines: [
            LyricLine(timeMs: 1_000, text: text, words: words ? [
                LyricWord(startMs: 1_000, endMs: 6_000, text: text)
            ] : [])
        ])).lines[0]
        let suite = "com.wildstring.mac.tests.lyric-layout"
        let preferences = UserDefaults(suiteName: suite)!
        preferences.set(true, forKey: "lyricsWordHighlight")
        defer { preferences.removePersistentDomain(forName: suite) }
        let view = NSHostingView(rootView: MacTimedLyricText(
            line: line, time: 3, font: .system(size: 30, weight: .semibold), centered: true
        ).frame(width: width).defaultAppStorage(preferences))
        return view.fittingSize
    }

    @Test func plainLyricsGrowVerticallyWhenTheColumnNarrows() {
        let wide = size(words: false, width: 800)
        let narrow = size(words: false, width: 220)
        #expect(narrow.width == 220)
        #expect(narrow.height > wide.height * 2)
    }

    @Test func longTimedSegmentFitsTheSameColumnAsPlainLyrics() {
        let plain = size(words: false, width: 220)
        let timed = size(words: true, width: 220)
        #expect(abs(timed.height - plain.height) < 2)
        #expect(timed.width == plain.width)
    }
}
