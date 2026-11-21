import AppKit
import CoreNetwork
import Observation
import SwiftUI
import Testing
@testable import WildString

extension MacAssistantTests {
    @Test func queueStateChangesPreserveTheEpisodeAndFollowingRowFrames() async throws {
        let episode = try JSONDecoder().decode(PodcastEpisode.self, from: Data(#"{"id":"presentation","podcast_id":"show","title":"517 关陇集团是如何炼成的：「八柱国」与西魏北周政权的崛起，以及长标题布局验证","duration_seconds":5219,"position_seconds":11}"#.utf8))
        for width in [CGFloat(390), 900] {
            for scheme in [ColorScheme.light, .dark] {
                let state = PresentationState()
                let root = RowsFixture(episode: episode, state: state).frame(width: width).preferredColorScheme(scheme)
                let host = NSHostingView(rootView: root)
                let window = presentationWindow(host, size: CGSize(width: width, height: 320))
                defer { window.close() }
                try await Task.sleep(for: .milliseconds(80))
                let initial = state.frames
                #expect(initial.count == 2)
                for phase in 0..<5 {
                    state.phase = phase
                    try await Task.sleep(for: .milliseconds(40))
                    host.layoutSubtreeIfNeeded()
                    #expect(state.frames == initial)
                    try saveScreenshot(host: host, name: "mac-stable-row-\(Int(width))-\(scheme)-\(phase)")
                }
            }
        }
    }

    @Test func transportGlyphSamplesIncludeTheTransitionAndNoMovementAfterLanding() async throws {
        for reduced in [false, true] {
            let state = PresentationState()
            let host = NSHostingView(rootView: GlyphFixture(state: state, reduced: reduced))
            let window = presentationWindow(host, size: CGSize(width: 120, height: 120))
            defer { window.close() }
            window.styleMask.insert(.titled)
            window.center()
            NSApp.activate()
            window.makeKeyAndOrderFront(nil)
            var previousImage: Data?
            var stableFrames = 0
            for _ in 0..<120 {
                host.layoutSubtreeIfNeeded()
                let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: rep)
                let image = try #require(rep.representation(using: .png, properties: [:]))
                stableFrames = previousImage == image ? stableFrames + 1 : 0
                previousImage = image
                if stableFrames >= 3 { break }
                try await Task.sleep(for: .milliseconds(16))
            }
            #expect(stableFrames >= 3)
            for (index, phase) in [1, 0, 2, 1].enumerated() {
                state.phase = phase
                var hashes: [Data] = []
                var frames: [[String: Any]] = []
                let start = ContinuousClock.now
                for _ in 0..<30 {
                    try await Task.sleep(for: .milliseconds(16))
                    host.layoutSubtreeIfNeeded()
                    let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                    host.cacheDisplay(in: host.bounds, to: rep)
                    let data = try #require(rep.representation(using: .png, properties: [:]))
                    let elapsed = start.duration(to: .now)
                    let ms = Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
                    func orange(_ x: Int, _ y: Int) -> Bool {
                        guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return false }
                        return c.redComponent > 0.75 && c.redComponent - c.greenComponent > 0.18 && c.greenComponent - c.blueComponent > 0.18
                    }
                    let xs = (0..<rep.pixelsWide).filter { orange($0, rep.pixelsHigh / 2) }
                    let ys = (0..<rep.pixelsHigh).filter { orange(rep.pixelsWide / 2, $0) }
                    let edges = try [#require(xs.first), #require(ys.first), #require(xs.last), #require(ys.last)]
                    frames.append(["time": ms, "changed": hashes.last.map { $0 != data } ?? false, "edges": edges])
                    hashes.append(data)
                }
                #expect(frames.allSatisfy { ($0["edges"] as! [Int]) == (frames.first!["edges"] as! [Int]) })
                if phase != 2 {
                    // First-time synchronous snapshot drawing can stall before the first visible
                    // change. Measure the visual curve from its first changed frame, not the setter.
                    let changes = frames.filter { $0["changed"] as! Bool }.map { $0["time"] as! Double }
                    let firstChange = changes.first ?? 0
                    #expect((changes.last ?? 0) - firstChange <= 272)
                    #expect(!frames.filter { ($0["time"] as! Double) > firstChange + 320 }.contains { $0["changed"] as! Bool })
                }
                if reduced { #expect(Set(hashes).count == 1) }
                else {
                    #expect(Set(hashes).count > 3, "Reduce Motion: \(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion); visible: \(window.occlusionState.contains(.visible))")
                }
                let path = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("wildstring-mac-glyph-\(reduced)-\(index)-\(phase).json")
                try JSONSerialization.data(withJSONObject: frames).write(to: path)
                try saveScreenshot(host: host, name: "mac-transport-\(reduced)-\(index)-\(phase)")
            }
        }
    }

    private func presentationWindow<V: View>(_ host: NSHostingView<V>, size: CGSize) -> NSWindow {
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        return window
    }
}

@Observable @MainActor private final class PresentationState {
    var phase = 0
    var frames: [Int: CGRect] = [:]
}

private struct RowFrames: PreferenceKey {
    static let defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) { value.merge(nextValue(), uniquingKeysWith: { _, new in new }) }
}

private struct RowsFixture: View {
    let episode: PodcastEpisode
    let state: PresentationState
    var body: some View {
        VStack(spacing: 8) {
            MacPodcastEpisodeRow(episode: episode, current: state.phase >= 2, playing: state.phase == 2,
                buffering: state.phase == 4, isQueued: state.phase == 1)
                .background(GeometryReader { p in Color.clear.preference(key: RowFrames.self, value: [0: p.frame(in: .named("rows"))]) })
            MacPodcastEpisodeRow(episode: episode)
                .background(GeometryReader { p in Color.clear.preference(key: RowFrames.self, value: [1: p.frame(in: .named("rows"))]) })
        }
        .coordinateSpace(name: "rows")
        .onPreferenceChange(RowFrames.self) { if state.frames != $0 { state.frames = $0 } }
        .padding(8)
        .background(MacTheme.canvas)
    }
}

private struct GlyphFixture: View {
    let state: PresentationState
    let reduced: Bool
    var body: some View {
        PlaybackTransportGlyph(playing: state.phase != 0, buffering: state.phase == 2, size: 24,
            foreground: MacTheme.onAccent, motionAllowed: !reduced)
            .frame(width: 64, height: 64).background(.orange, in: Circle())
            .frame(width: 120, height: 120).background(.white)
            .preferredColorScheme(.light)
    }
}
