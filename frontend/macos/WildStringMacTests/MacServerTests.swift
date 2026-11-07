import CoreNetwork
import CorePlayback
import Foundation
import Testing
@testable import WildString

extension MacAssistantTests {
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
}
