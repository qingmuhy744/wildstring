import Foundation
import Testing
@testable import CoreNetwork

@Suite("WildstringClient", .serialized)
struct WildstringClientTests {
    private let origin = "https://music.example.com"

    private func makeClient(store: InMemorySessionStore) throws -> WildstringClient {
        WildstringClient(
            server: try ServerAddress(input: "music.example.com"),
            store: store,
            configuration: StubURLProtocol.configuration()
        )
    }

    @Test func loginSendsIOSClientHeaderAndPersistsCookies() async throws {
        let userJSON = #"{"id":"admin","username":"admin","role":"admin","version":3,"enabled":true}"#
        let store = InMemorySessionStore()
        StubURLProtocol.respond { request in
            #expect(request.httpMethod == "POST")
            #expect(request.url?.path == "/api/v1/auth/login")
            #expect(request.value(forHTTPHeaderField: "X-Wildstring-Client") == "ios")
            let body = try #require(StubURLProtocol.bodyData(of: request))
            let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: String])
            #expect(json["username"] == "admin")
            #expect(json["password"] == "fixture-admin-password")
            return .json(
                status: 200,
                headers: ["Set-Cookie": "wildstring_session=token-123; Path=/; HttpOnly; Max-Age=604800"],
                body: userJSON
            )
        }
        let client = try makeClient(store: store)
        let user = try await client.login(username: "admin", password: "fixture-admin-password")
        #expect(user.username == "admin")
        #expect(user.role == "admin")
        let session = try #require(try store.loadSession(origin: origin))
        #expect(session.cookies.map(\.name) == ["wildstring_session"])
        #expect(session.cookies.first?.value == "token-123")
        let hasSession = await client.storedSessionExists()
        #expect(hasSession)
    }

    @Test func loginFailureSurfacesStableServerCode() async throws {
        let store = InMemorySessionStore()
        StubURLProtocol.respond { _ in
            .json(status: 401, body: #"{"detail":"invalid_credentials"}"#)
        }
        let client = try makeClient(store: store)
        await #expect(throws: APIError(statusCode: 401, code: "invalid_credentials")) {
            try await client.login(username: "admin", password: "wrong")
        }
        #expect(try store.loadSession(origin: origin) == nil)
    }

    @Test func olderServersRetryWithWebClientHeader() async throws {
        let userJSON = #"{"id":"admin","username":"admin","role":"admin","version":3,"enabled":true}"#
        let store = InMemorySessionStore()
        StubURLProtocol.respond { request in
            let header = request.value(forHTTPHeaderField: "X-Wildstring-Client")
            if header == "web" {
                return .json(status: 200, body: userJSON)
            }
            return .json(status: 403, body: #"{"detail":"client_header_required"}"#)
        }
        let client = try makeClient(store: store)
        let user = try await client.login(username: "admin", password: "fixture-admin-password")
        #expect(user.username == "admin")
    }

    @Test func statusSendsStoredSessionCookie() async throws {
        let userJSON = #"{"id":"admin","username":"admin","role":"admin","version":3,"enabled":true}"#
        let store = InMemorySessionStore()
        try store.saveSession(
            StoredSession(cookies: [
                StoredCookie(
                    name: "wildstring_session",
                    value: "token-abc",
                    domain: "music.example.com",
                    path: "/"
                ),
            ]),
            origin: origin
        )
        StubURLProtocol.respond { request in
            #expect(request.value(forHTTPHeaderField: "Cookie") == "wildstring_session=token-abc")
            return .json(
                status: 200,
                body: #"{"configured":true,"authenticated":true,"user":\#(userJSON)}"#
            )
        }
        let client = try makeClient(store: store)
        let status = try await client.authStatus()
        #expect(status.authenticated)
        #expect(status.user?.username == "admin")
    }

    @Test func expiredCookiesAreNotSent() async throws {
        let store = InMemorySessionStore()
        try store.saveSession(
            StoredSession(cookies: [
                StoredCookie(
                    name: "old",
                    value: "x",
                    domain: "music.example.com",
                    path: "/",
                    expiresAt: Date(timeIntervalSinceNow: -60)
                ),
                StoredCookie(
                    name: "fresh",
                    value: "y",
                    domain: "music.example.com",
                    path: "/",
                    expiresAt: Date(timeIntervalSinceNow: 60)
                ),
            ]),
            origin: origin
        )
        StubURLProtocol.respond { request in
            #expect(request.value(forHTTPHeaderField: "Cookie") == "fresh=y")
            return .json(status: 200, body: #"{"configured":true,"authenticated":false}"#)
        }
        let client = try makeClient(store: store)
        _ = try await client.authStatus()
    }

    @Test func logoutClearsStoredSession() async throws {
        let store = InMemorySessionStore()
        try store.saveSession(
            StoredSession(cookies: [
                StoredCookie(
                    name: "wildstring_session",
                    value: "token-abc",
                    domain: "music.example.com",
                    path: "/"
                ),
            ]),
            origin: origin
        )
        StubURLProtocol.respond { _ in .empty(status: 204) }
        let client = try makeClient(store: store)
        try await client.logout()
        #expect(try store.loadSession(origin: origin) == nil)
        let hasSession = await client.storedSessionExists()
        #expect(!hasSession)
    }
}
