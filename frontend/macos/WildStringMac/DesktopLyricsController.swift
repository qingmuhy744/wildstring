import AppKit
import Observation
import SwiftUI

@MainActor
@Observable
final class DesktopLyricsController: NSObject, NSWindowDelegate {
    private(set) var isVisible = false
    @ObservationIgnored private(set) var panel: NSPanel?

    func toggle(session: MacSession) {
        if panel?.isVisible == true {
            close()
            return
        }
        if panel == nil {
            let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 540, height: 112),
                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.isOpaque = false
            window.backgroundColor = .clear
            window.level = .floating
            window.hidesOnDeactivate = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            window.delegate = self
            if let frame = NSScreen.main?.visibleFrame {
                window.setFrameOrigin(NSPoint(x: frame.midX - 270, y: frame.minY + 70))
            }
            panel = window
        }
        panel?.contentView = NSHostingView(rootView: DesktopLyricsView(session: session))
        setClickThrough(UserDefaults.standard.bool(forKey: "desktopLyricsClickThrough"))
        panel?.orderFrontRegardless()
        isVisible = true
    }

    func close() {
        panel?.close()
        isVisible = false
    }

    func setClickThrough(_ value: Bool) {
        panel?.ignoresMouseEvents = value
    }

    func windowWillClose(_ notification: Notification) {
        isVisible = false
        panel?.contentView = nil
    }
}

struct DesktopLyricsDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> DragView { DragView() }
    func updateNSView(_ nsView: DragView, context: Context) {}

    final class DragView: NSView {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    }
}
