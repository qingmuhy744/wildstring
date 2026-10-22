import Foundation
import Testing
@testable import CoreNetwork

/// Runs against a disposable local server when WILDSTRING_INTEGRATION_URL is set:
/// `WILDSTRING_INTEGRATION_URL=http://127.0.0.1:18799 WILDSTRING_INTEGRATION_PASSWORD=... make ios-test`
@Suite("Integration", .serialized)
struct IntegrationTests {
    private var environment: [String: String] { ProcessInfo.processInfo.environment }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["WILDSTRING_INTEGRATION_URL"] != nil))
    func loginSessionAndLogoutAgainstRealServer() async throws {
        let url = try #require(environment["WILDSTRING_INTEGRATION_URL"])
        let password = try #require(environment["WILDSTRING_INTEGRATION_PASSWORD"])
        let username = environment["WILDSTRING_INTEGRATION_USERNAME"] ?? "admin"
        let store = InMemorySessionStore()
        let address = try ServerAddress(input: url, allowsInsecureHTTP: true)
        let client = WildstringClient(server: address, store: store)

        let initial = try await client.authStatus()
        #expect(initial.configured)
        #expect(!initial.authenticated)

        let user = try await client.login(username: username, password: password)
        #expect(user.username == username)

        let stored = try #require(try store.loadSession(origin: address.origin))
        #expect(!stored.cookies.isEmpty)

        let authenticated = try await client.authStatus()
        #expect(authenticated.authenticated)
        #expect(authenticated.user?.id == user.id)

        try await client.logout()
        #expect(try store.loadSession(origin: address.origin) == nil)
        let afterLogout = try await client.authStatus()
        #expect(!afterLogout.authenticated)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["WILDSTRING_INTEGRATION_URL"] != nil))
    func wrongPasswordSurfacesStableCode() async throws {
        let url = try #require(environment["WILDSTRING_INTEGRATION_URL"])
        let client = WildstringClient(
            server: try ServerAddress(input: url, allowsInsecureHTTP: true),
            store: InMemorySessionStore()
        )
        await #expect(throws: APIError(statusCode: 401, code: "invalid_credentials")) {
            try await client.login(username: "admin", password: "definitely-wrong-password")
        }
    }
}
