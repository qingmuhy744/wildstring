import CoreNetwork
import CorePlayback
import Foundation
import Testing
@testable import WildString

extension MacAssistantTests {
    @Test func longSharedQueueUsesCurrentWindowForOfferAndManualLoad() async throws {
        let ids = (0..<450).map { "t\($0)" }
        let state = try JSONSerialization.data(withJSONObject: [
            "version": 5, "device_id": "remote", "track_ids": ids, "index": 300,
            "position_ms": 42500, "mode": "sequential", "playback_state": "paused", "handoff_eligible": true
        ])
        let stateJSON = String(decoding: state, as: UTF8.self)
        StubURLProtocol.respond { request in
            let path = request.url!.path
            if path == "/api/v1/playback/state" { return .json(body: stateJSON) }
            if path.hasPrefix("/api/v1/tracks/") {
                let id = request.url!.lastPathComponent
                return .json(body: #"{"id":"\#(id)","title":"\#(id)","artists":[],"album":null,"duration_ms":1000,"has_cover":false}"#)
            }
            return .empty(status: 404)
        }
        defer { StubURLProtocol.reset() }
        let server = try ServerAddress(input: "music.example.com")
        let client = WildstringClient(server: server, store: InMemorySessionStore(), configuration: StubURLProtocol.configuration())
        let playback = PlaybackService(server: server, store: InMemoryQueueStore(), cookieHeader: { nil })
        defer { playback.shutdown() }
        let sync = MacPlaybackSync(client: client, playback: playback, deviceId: "local")
        await sync.poll()
        let offer = try #require(sync.handoff)
        #expect(offer.title == "t300")
        #expect(offer.index == 0)
        #expect(offer.tracks.count == 100)
        #expect(Set(StubURLProtocol.requests.filter { $0.url!.path.hasPrefix("/api/v1/tracks/") }.map { $0.url!.lastPathComponent }) == Set(ids[300..<400]))
        await sync.accept()
        #expect(playback.currentItem?.trackID == "t300")
        #expect(playback.currentTime == 42.5)
        await sync.loadRemote()
        #expect(playback.items.count == 100)
        #expect(playback.currentItem?.trackID == "t300")
        #expect(playback.currentTime == 42.5)
        #expect(!playback.wantsPlayback)
    }

    @Test func addingServerAuthenticatesBeforeReplacingCurrentConnection() async throws {
        let suite = "wildstring.server-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = InMemorySessionStore()
        let currentAddress = try ServerAddress(input: "current.example.invalid")
        try store.saveSession(StoredSession(cookies: [
            StoredCookie(name: "session", value: "test-fixture", domain: "current.example.invalid", path: "/", isSecure: true)
        ]), origin: currentAddress.origin)
        MacServers.upsert(MacSavedServer(address: currentAddress.description, username: "listener",
            lastUsedAt: .now, allowInsecureHTTP: false), defaults: defaults)
        let user = #"{"id":"u1","username":"listener","profile":"listener","version":1,"enabled":true}"#
        StubURLProtocol.respond { request in
            if request.url!.path == "/api/v1/auth/login" {
                if request.url!.host == "denied.example.invalid" { return .empty(status: 401) }
                return .json(headers: ["Set-Cookie": "session=test-fixture; Path=/; Secure"], body: user)
            }
            if request.url!.path == "/api/v1/auth/status" {
                return .json(body: "{\"configured\":true,\"authenticated\":true,\"user\":\(user)}")
            }
            return .empty(status: 404)
        }
        let session = MacSession(store: store, queueStore: try SwiftDataQueueStore.inMemory(),
            defaults: defaults, configuration: StubURLProtocol.configuration())
        await session.restore()
        let originalPlayback = try #require(session.playback)
        session.addServer()
        await session.login(serverText: "https://denied.example.invalid", username: "listener",
            password: "test-password", allowInsecureHTTP: false)
        #expect(session.playback === originalPlayback)
        #expect(session.client?.server.origin == currentAddress.origin)
        #expect(session.errorMessage != nil)
        #expect(session.showServerLogin)
        await session.login(serverText: "https://new.example.invalid", username: "listener",
            password: "test-password", allowInsecureHTTP: false)
        #expect(session.client?.server.url.host == "new.example.invalid")
        #expect(session.servers.count == 2)
        #expect(!session.showServerLogin)
        #expect(session.errorMessage == nil)
        #expect(try store.loadSession(origin: currentAddress.origin) != nil)
        await session.logout()
    }

    @Test func switchingServersPreservesSessionsAndIndependentQueues() async throws {
        let suite = "wildstring.server-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = InMemorySessionStore()
        let servers = try ["first.example.invalid", "second.example.invalid"].enumerated().map { index, host in
            let address = try ServerAddress(input: host)
            try store.saveSession(StoredSession(cookies: [
                StoredCookie(name: "session", value: "test-fixture", domain: host, path: "/", isSecure: true)
            ]), origin: address.origin)
            let server = MacSavedServer(address: address.description, username: host,
                lastUsedAt: Date(timeIntervalSince1970: Double(100 - index)), allowInsecureHTTP: false)
            MacServers.upsert(server, defaults: defaults)
            return server
        }
        StubURLProtocol.respond { request in
            if request.url!.path == "/api/v1/auth/status" {
                let host = request.url!.host!
                return .json(body: "{\"configured\":true,\"authenticated\":true,\"user\":{\"id\":\"\(host)\",\"username\":\"\(host)\",\"profile\":\"listener\",\"version\":1,\"enabled\":true}}")
            }
            if request.url!.path == "/api/v1/favorites/ids" { return .json(body: #"{"ids":[]}"#) }
            return .empty(status: 404)
        }
        let session = MacSession(store: store, queueStore: try SwiftDataQueueStore.inMemory(),
            defaults: defaults, configuration: StubURLProtocol.configuration())
        await session.restore()
        let firstPlayback = try #require(session.playback)
        let first = PlaybackService.Item(trackID: "first-track", title: "First", artist: "Artist", streamPath: "unused")
        firstPlayback.adopt(items: [first], startingAt: 0, position: 32.289, mode: "sequential")
        session.selectLibrary("first-library")
        session.showQueue = true
        session.page = .assistant

        await session.switchServer(servers[1])
        #expect(session.client?.server.description == servers[1].address)
        #expect(session.selectedLibraryID == nil)
        #expect(session.page == .home)
        #expect(!session.showQueue)
        #expect(firstPlayback.items.isEmpty)
        let secondPlayback = try #require(session.playback)
        #expect(secondPlayback.items.isEmpty)
        let second = PlaybackService.Item(trackID: "second-track", title: "Second", artist: "Artist", streamPath: "unused")
        secondPlayback.adopt(items: [second], startingAt: 0, position: 17, mode: "sequential")

        await session.switchServer(servers[0])
        #expect(session.playback?.currentItem?.trackID == "first-track")
        #expect(session.playback?.currentTime == 32.289)
        #expect(session.playback?.isPlaying == false)
        #expect(session.selectedLibraryID == "first-library")
        await session.switchServer(servers[1])
        #expect(session.playback?.currentItem?.trackID == "second-track")
        #expect(session.playback?.currentTime == 17)
        #expect(!StubURLProtocol.requests.contains { $0.url!.path == "/api/v1/auth/logout" })
        for server in servers {
            #expect(try store.loadSession(origin: ServerAddress(input: server.address).origin) != nil)
        }
        await session.logout()
        #expect(session.phase == .connect)
        #expect(try store.loadSession(origin: ServerAddress(input: servers[0].address).origin) != nil)
        #expect(try store.loadSession(origin: ServerAddress(input: servers[1].address).origin) == nil)
    }

    @Test func unavailableOrExpiredServerLeavesCurrentConnectionUsable() async throws {
        let suite = "wildstring.server-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = InMemorySessionStore()
        for host in ["current.example.invalid", "offline.example.invalid", "expired.example.invalid"] {
            let address = try ServerAddress(input: host)
            try store.saveSession(StoredSession(cookies: [
                StoredCookie(name: "session", value: "test-fixture", domain: host, path: "/", isSecure: true)
            ]), origin: address.origin)
        }
        let current = MacSavedServer(address: "https://current.example.invalid", username: "listener",
            lastUsedAt: .now, allowInsecureHTTP: false)
        MacServers.upsert(current, defaults: defaults)
        StubURLProtocol.respond { request in
            if request.url!.path == "/api/v1/auth/status" {
                switch request.url!.host {
                case "offline.example.invalid": throw URLError(.cannotConnectToHost)
                case "expired.example.invalid":
                    return .json(body: #"{"configured":true,"authenticated":false,"user":null}"#)
                default:
                    return .json(body: #"{"configured":true,"authenticated":true,"user":{"id":"u1","username":"listener","profile":"listener","version":1,"enabled":true}}"#)
                }
            }
            return .empty(status: 404)
        }
        let session = MacSession(store: store, queueStore: InMemoryQueueStore(), defaults: defaults,
            configuration: StubURLProtocol.configuration())
        await session.restore()
        let playback = try #require(session.playback)
        let offline = MacSavedServer(address: "https://offline.example.invalid", username: "listener",
            lastUsedAt: .now, allowInsecureHTTP: false)
        await session.switchServer(offline)
        #expect(session.client?.server.description == current.address)
        #expect(session.playback === playback)
        #expect(session.serverSwitchError != nil)
        let expired = MacSavedServer(address: "https://expired.example.invalid", username: "listener",
            lastUsedAt: .now, allowInsecureHTTP: false)
        await session.switchServer(expired)
        #expect(session.showServerLogin)
        #expect(session.pendingServer?.address == expired.address)
        #expect(session.client?.server.description == current.address)
        #expect(session.playback === playback)
        #expect(!StubURLProtocol.requests.contains { $0.url!.path == "/api/v1/auth/logout" })
        session.showServerLogin = false
        await session.logout()
    }

    @Test func deletingServerRemovesCredentialsAndSwitchesOrResetsConnection() async throws {
        let suite = "wildstring.server-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = InMemorySessionStore()
        let servers = try ["first.example.invalid", "second.example.invalid"].enumerated().map { index, host in
            let address = try ServerAddress(input: host)
            try store.saveSession(StoredSession(cookies: [
                StoredCookie(name: "session", value: "test-fixture", domain: host, path: "/", isSecure: true)
            ]), origin: address.origin)
            let server = MacSavedServer(address: address.description, username: host,
                lastUsedAt: Date(timeIntervalSince1970: Double(100 - index)), allowInsecureHTTP: false)
            MacServers.upsert(server, defaults: defaults)
            return server
        }
        StubURLProtocol.respond { request in
            if request.url!.path == "/api/v1/auth/status" {
                let host = request.url!.host!
                return .json(body: "{\"configured\":true,\"authenticated\":true,\"user\":{\"id\":\"\(host)\",\"username\":\"\(host)\",\"profile\":\"listener\",\"version\":1,\"enabled\":true}}")
            }
            if request.url!.path == "/api/v1/favorites/ids" { return .json(body: #"{"ids":[]}"#) }
            return .empty(status: 404)
        }
        let queueStore = try SwiftDataQueueStore.inMemory()
        let session = MacSession(store: store, queueStore: queueStore,
            defaults: defaults, configuration: StubURLProtocol.configuration())
        await session.restore()
        #expect(session.servers.count == 2)
        #expect(session.client?.server.description == servers[0].address)

        // Delete active server (first)
        await session.deleteServer(servers[0])

        // First server should be removed from saved servers and credentials cleared
        #expect(session.servers.count == 1)
        #expect(session.servers.first?.address == servers[1].address)
        #expect(try store.loadSession(origin: ServerAddress(input: servers[0].address).origin) == nil)

        // Session automatically switched to second server
        #expect(session.client?.server.description == servers[1].address)
        #expect(try store.loadSession(origin: ServerAddress(input: servers[1].address).origin) != nil)

        // Delete the remaining server (second)
        await session.deleteServer(servers[1])
        #expect(session.servers.isEmpty)
        #expect(session.phase == .connect)
        #expect(session.client == nil)
        #expect(try store.loadSession(origin: ServerAddress(input: servers[1].address).origin) == nil)
    }

    @Test func restoreClearsUnavailableSavedLibrary() async throws {
        let suite = "wildstring.server-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = InMemorySessionStore()
        let address = try ServerAddress(input: "library.example.invalid")
        try store.saveSession(StoredSession(cookies: [
            StoredCookie(name: "session", value: "test-fixture", domain: "library.example.invalid", path: "/", isSecure: true)
        ]), origin: address.origin)
        MacServers.upsert(MacSavedServer(address: address.description, username: "listener",
            lastUsedAt: .now, allowInsecureHTTP: false), defaults: defaults)
        let libraryKey = "mac.library.\(address.description)|listener"
        defaults.set("stale-library", forKey: libraryKey)
        let user = #"{"id":"u1","username":"listener","profile":"listener","version":1,"enabled":true}"#
        StubURLProtocol.respond { request in
            switch request.url!.path {
            case "/api/v1/auth/status":
                return .json(body: "{\"configured\":true,\"authenticated\":true,\"user\":\(user)}")
            case "/api/v1/libraries":
                return .json(body: #"[{"id":"active-library","name":"Active","enabled":true,"is_default":true}]"#)
            case "/api/v1/favorites/ids":
                return .json(body: #"{"ids":[]}"#)
            default:
                return .empty(status: 404)
            }
        }
        defer { StubURLProtocol.reset() }
        let session = MacSession(store: store, queueStore: try SwiftDataQueueStore.inMemory(),
            defaults: defaults, configuration: StubURLProtocol.configuration())
        await session.restore()
        #expect(session.selectedLibraryID == nil)
        #expect(session.client?.selectedLibrary() == nil)
        #expect(defaults.string(forKey: libraryKey) == nil)
        await session.logout()
    }
}
