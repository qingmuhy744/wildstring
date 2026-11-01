import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI
import Testing
@testable import WildString

@Suite("Desktop lyrics", .serialized)
@MainActor
struct DesktopLyricsTests {
    @Test func closingAndReopeningKeepsTheNativeWindowAndPosition() {
        let session = MacSession()
        let lyrics = session.desktopLyrics
        defer { lyrics.close() }
        lyrics.toggle(session: session)
        let window = lyrics.panel!
        #expect(lyrics.isVisible && window.isVisible)
        #expect(window.contentView is NSHostingView<DesktopLyricsView>)
        window.setFrameOrigin(NSPoint(x: 160, y: 180))
        window.close()
        #expect(!lyrics.isVisible)
        #expect(window.contentView == nil)
        lyrics.toggle(session: session)
        #expect(lyrics.panel === window)
        #expect(window.isVisible && lyrics.isVisible)
        #expect(window.contentView is NSHostingView<DesktopLyricsView>)
        #expect(window.frame.origin == NSPoint(x: 160, y: 180))
        lyrics.setClickThrough(true)
        #expect(window.ignoresMouseEvents)
        lyrics.setClickThrough(false)
        #expect(!window.ignoresMouseEvents)
        let dragArea = DesktopLyricsDragArea.DragView(frame: NSRect(x: 0, y: 0, width: 540, height: 112))
        #expect(dragArea.acceptsFirstMouse(for: nil))
        #expect(dragArea.hitTest(NSPoint(x: 270, y: 56)) === dragArea)
        lyrics.toggle(session: session)
        #expect(!window.isVisible && !lyrics.isVisible)
    }

    @Test func translationUsesTheSamePreferenceAsTheMainPlayer() {
        let suite = "com.wildstring.mac.tests.desktop-translation"
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let line = LyricTimeline(lyrics: Lyrics(kind: "synced", lines: [
            LyricLine(timeMs: 0, text: "Hello world", translation: "你好，世界")
        ])).lines[0]
        func height(_ enabled: Bool) -> CGFloat {
            preferences.set(enabled, forKey: "lyricsShowTranslation")
            return NSHostingView(rootView: DesktopLyricLine(line: line, time: 0)
                .frame(width: 472).defaultAppStorage(preferences)).fittingSize.height
        }
        #expect(height(true) > height(false) + 15)
        #expect(height(true) < 88)
    }
}
