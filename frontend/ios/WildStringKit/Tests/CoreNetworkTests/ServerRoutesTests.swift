import Foundation
import Testing
@testable import CoreNetwork

extension StubbedHTTPTests {
    @Suite("Server routes") @MainActor
    struct ServerRoutesSuite {
        private let infoJSON = #"{"instance_id":"fixture-server","name":"家里的音乐库","connection_policy":"mixed"}"#
        private let userJSON = #"{"id":"admin","username":"admin","profile":"owner","version":1,"enabled":true}"#

        @Test func independentSessionsFallbackManualAndPersistentPriority() async throws {
            let store = InMemorySessionStore()
            let suite = "routes-test-" + UUID().uuidString
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite); StubURLProtocol.reset() }
            let primary = ServerRoute(name: "内网", address: "http://lan.invalid", allowHTTP: true)
            let routes = ServerRoutes(primary: primary, defaults: defaults) {
                WildstringClient(server: $0, store: store, configuration: StubURLProtocol.configuration())
            }
            let info = try JSONDecoder().decode(ServerInfo.self, from: Data(infoJSON.utf8))
            routes.bind(info: info, userID: "admin", activeAddress: primary.address)
            try store.saveSession(StoredSession(cookies: [StoredCookie(name: "wildstring_session_http", value: "lan-fixture", domain: "lan.invalid", path: "/")]), origin: primary.address)
            let status = "{\"configured\":true,\"authenticated\":true,\"server\":\(infoJSON),\"user\":\(userJSON)}"
            let infoBody = infoJSON, userBody = userJSON
            StubURLProtocol.respond { request in
                if request.url!.path == "/api/v1/server" { return .json(body: infoBody) }
                if request.url!.path == "/api/v1/auth/login" {
                    #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
                    return .json(headers: ["Set-Cookie": "wildstring_session_https=wan-fixture; Secure; Path=/"], body: userBody)
                }
                return .json(body: status)
            }
            try await routes.add(name: "公网", address: "https://wan.invalid", allowHTTP: false, username: "admin", password: "fixture-password")
            routes.stop()
            #expect(routes.profile.routes.count == 2)
            StubURLProtocol.respond { request in
                if request.url?.host == "lan.invalid" { throw URLError(.cannotConnectToHost) }
                #expect(request.value(forHTTPHeaderField: "Cookie") == "wildstring_session_https=wan-fixture")
                return .json(body: status)
            }
            await routes.probe(); await routes.probe()
            #expect(routes.profile.activeAddress == "https://wan.invalid")
            #expect(routes.profile.manualAddress == nil)
            StubURLProtocol.respond { _ in .json(body: status) }
            await routes.probe()
            #expect(routes.profile.activeAddress == "https://wan.invalid")
            await routes.select(primary.address)
            #expect(routes.profile.activeAddress == primary.address)
            StubURLProtocol.respond { request in
                if request.url?.host == "lan.invalid" { throw URLError(.cannotConnectToHost) }
                return .json(body: status)
            }
            await routes.probe(); await routes.probe()
            #expect(routes.profile.activeAddress == primary.address)
            #expect(await routes.restore() == nil)
            await routes.select(nil)
            #expect(routes.profile.activeAddress == "https://wan.invalid")
            routes.move(routes.profile.routes[1], by: -1)
            let restored = ServerRoutes(primary: primary, defaults: defaults) {
                WildstringClient(server: $0, store: store, configuration: StubURLProtocol.configuration())
            }
            #expect(restored.profile.routes.first?.name == "公网")
            #expect(restored.storageAddress == primary.address)
            #expect(restored.profile.manualAddress == nil)
        }

        @Test func mismatchNeverSendsLoginAndSecureCookieNeverTravelsOverHTTP() async throws {
            let store = InMemorySessionStore()
            let suite = "routes-test-" + UUID().uuidString
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite); StubURLProtocol.reset() }
            let primary = ServerRoute(name: "主线路", address: "http://lan.invalid", allowHTTP: true)
            let routes = ServerRoutes(primary: primary, defaults: defaults) {
                WildstringClient(server: $0, store: store, configuration: StubURLProtocol.configuration())
            }
            routes.bind(info: try JSONDecoder().decode(ServerInfo.self, from: Data(infoJSON.utf8)), userID: "admin", activeAddress: primary.address)
            StubURLProtocol.respond { _ in .json(body: #"{"instance_id":"different","name":"其他服务器","connection_policy":"mixed"}"#) }
            await #expect(throws: APIError.self) {
                try await routes.add(name: "错误地址", address: "https://other.invalid", allowHTTP: false, username: "admin", password: "fixture-password")
            }
            #expect(StubURLProtocol.requests.count == 1)
            #expect(StubURLProtocol.requests.first?.httpMethod == "GET")
            try store.saveSession(StoredSession(cookies: [StoredCookie(name: "wildstring_session_https", value: "fixture", domain: "lan.invalid", path: "/", isSecure: true)]), origin: primary.address)
            let client = WildstringClient(server: try ServerAddress(input: primary.address, allowsInsecureHTTP: true), store: store, configuration: StubURLProtocol.configuration())
            #expect(await client.cookieHeaderValue() == nil)
        }
    }
}
