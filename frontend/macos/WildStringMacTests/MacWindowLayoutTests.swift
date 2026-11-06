import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI
import Testing
@testable import WildString

extension MacAssistantTests {
    @Test func switchingPagesKeepsWindowControlsAndContentPositionStable() async throws {
        let suite = "wildstring.window-layout-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let address = try ServerAddress(input: "window-layout.example.invalid")
        let store = InMemorySessionStore()
        try store.saveSession(StoredSession(cookies: [
            StoredCookie(name: "session", value: "test-fixture", domain: address.url.host!, path: "/", isSecure: true)
        ]), origin: address.origin)
        MacServers.upsert(MacSavedServer(address: address.description, username: "listener",
            lastUsedAt: .now, allowInsecureHTTP: false), defaults: defaults)
        StubURLProtocol.respond { request in
            switch request.url!.path {
            case "/api/v1/auth/status":
                return .json(body: #"{"configured":true,"authenticated":true,"user":{"id":"u1","username":"listener","profile":"listener","version":1,"enabled":true}}"#)
            case "/api/v1/favorites/ids":
                return .json(body: #"{"ids":[]}"#)
            default:
                return .json(body: #"{"items":[],"total":0,"limit":100,"offset":0}"#)
            }
        }
        let session = MacSession(store: store, queueStore: InMemoryQueueStore(), defaults: defaults,
            configuration: StubURLProtocol.configuration())
        await session.restore()
        #expect(session.client != nil)
        defer {
            session.sync?.stop()
            session.connection?.stop()
            session.playback?.shutdown()
        }
        let host = NSHostingView(rootView: MacRootView(session: session).defaultAppStorage(defaults))
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }

        try await Task.sleep(for: .milliseconds(350))
        host.layoutSubtreeIfNeeded()
        let close = try #require(window.standardWindowButton(.closeButton))
        let initialCloseFrame = close.convert(close.bounds, to: nil)
        let initialContentRect = window.contentLayoutRect
        let initialWindowFrame = window.frame
        // Include pages with toolbar actions and sample during the transition,
        // not just after it settles. All fixtures use an isolated session.
        for page: MacPage in [.home, .search, .assistant, .tracks, .settings, .home, .favorites, .search, .assistant, .home] {
            session.page = page
            for delay in [30, 100, 250] {
                try await Task.sleep(for: .milliseconds(delay))
                host.layoutSubtreeIfNeeded()
                #expect(close.convert(close.bounds, to: nil) == initialCloseFrame, "Close button moved on \(page.rawValue)")
                #expect(window.contentLayoutRect == initialContentRect, "Content shifted on \(page.rawValue)")
                #expect(window.frame == initialWindowFrame, "Window resized on \(page.rawValue)")
            }
        }
    }
}
