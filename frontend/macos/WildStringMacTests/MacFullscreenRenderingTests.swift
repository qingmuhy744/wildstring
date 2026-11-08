import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI
import Testing
@testable import WildString

extension MacAssistantTests {
    @Test func fullscreenPlayerRendersWideAndNarrowInBothSchemes() async throws {
        let cover = try pngFixture(.init(calibratedRed: 0.55, green: 0.32, blue: 0.22, alpha: 1))
        StubURLProtocol.respond { request in
            let path = request.url!.path
            if path.hasSuffix("/lyrics") {
                return .json(body: #"{"kind":"synced","source":"测试","lines":[{"time_ms":0,"text":"第一行歌词"},{"time_ms":5000,"text":"第二行歌词"},{"time_ms":10000,"text":"第三行歌词"}]}"#)
            }
            if path.hasSuffix("/cover") {
                return StubURLProtocol.Stub(statusCode: 200, headers: ["Content-Type": "image/png"], body: cover)
            }
            return .empty(status: 404)
        }
        let client = WildstringClient(server: try ServerAddress(input: "music.example.com"),
            store: InMemorySessionStore(), configuration: StubURLProtocol.configuration())
        let playback = PlaybackService(server: client.server, store: InMemoryQueueStore(), cookieHeader: { nil })
        playback.adopt(items: [
            .init(trackID: "song-1", title: "从头再来", artist: "崔健", album: "新长征路上的摇滚", streamPath: "unused"),
            .init(trackID: "song-2", title: "第二首歌", artist: "测试艺人", streamPath: "unused"),
            .init(trackID: "song-3", title: "第三首歌", artist: "测试艺人", streamPath: "unused"),
        ], startingAt: 0, position: 14, mode: "sequential")
        defer { playback.shutdown() }
        let session = MacSession()
        session.showFullscreen = true

        try await capture(MacFullscreenPlayer(session: session, client: client, playback: playback),
            size: NSSize(width: 1440, height: 900), scheme: .light, name: "mac-full-wide-light")
        try await capture(MacFullscreenPlayer(session: session, client: client, playback: playback),
            size: NSSize(width: 1440, height: 900), scheme: .dark, name: "mac-full-wide-dark")
        try await capture(MacFullscreenPlayer(session: session, client: client, playback: playback),
            size: NSSize(width: 820, height: 900), scheme: .dark, name: "mac-full-narrow-dark")
        try await capture(MacFullscreenPlayer(session: session, client: client, playback: playback,
                initialLyrics: false, initialQueue: true),
            size: NSSize(width: 1440, height: 900), scheme: .light, name: "mac-full-queue-light")
    }

    private func pngFixture(_ color: NSColor) throws -> Data {
        let image = NSImage(size: NSSize(width: 96, height: 96), flipped: false) { rect in
            color.setFill(); rect.fill(); return true
        }
        let tiff = try #require(image.tiffRepresentation)
        return try #require(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
    }

    private func capture(_ view: MacFullscreenPlayer, size: NSSize, scheme: ColorScheme, name: String) async throws {
        let host = NSHostingView(rootView: view.preferredColorScheme(scheme))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: size.width, height: size.height),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(600))
        host.layoutSubtreeIfNeeded()
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try #require(bitmap.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: "/tmp/wildstring-\(name).png"))
    }
}
