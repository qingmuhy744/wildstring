import Foundation
import Testing
@testable import CoreNetwork

@Suite("Session storage")
struct SessionStoreTests {
    @Test func inMemoryStoreRoundTripsSessionsByOrigin() throws {
        let store = InMemorySessionStore()
        let session = StoredSession(cookies: [
            StoredCookie(
                name: "wildstring_session",
                value: "abc",
                domain: "music.example.com",
                path: "/",
                expiresAt: nil,
                isSecure: true
            ),
        ])
        try store.saveSession(session, origin: "https://music.example.com")
        #expect(try store.loadSession(origin: "https://music.example.com") == session)
        #expect(try store.loadSession(origin: "https://other.example.com") == nil)
    }

    @Test func clearingOneOriginKeepsOthers() throws {
        let store = InMemorySessionStore()
        let session = StoredSession(cookies: [])
        try store.saveSession(session, origin: "https://a.example.com")
        try store.saveSession(session, origin: "https://b.example.com")
        try store.clearSession(origin: "https://a.example.com")
        #expect(try store.loadSession(origin: "https://a.example.com") == nil)
        #expect(try store.loadSession(origin: "https://b.example.com") != nil)
    }

    @Test func storedSessionRoundTripsThroughJSON() throws {
        let session = StoredSession(cookies: [
            StoredCookie(
                name: "wildstring_session",
                value: "abc",
                domain: "music.example.com",
                path: "/",
                expiresAt: Date(timeIntervalSince1970: 1_700_000_000),
                isSecure: false
            ),
        ])
        let data = try JSONEncoder().encode(session)
        #expect(try JSONDecoder().decode(StoredSession.self, from: data) == session)
    }
}
