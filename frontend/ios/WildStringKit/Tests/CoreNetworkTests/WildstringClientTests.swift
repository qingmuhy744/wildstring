import Foundation
import Testing
@testable import CoreNetwork

/// Suites that drive StubURLProtocol live under one serialized parent so the
/// shared stub handler never races across suites.
@Suite("Stubbed HTTP", .serialized)
struct StubbedHTTPTests {
    @Suite("WildstringClient")
    struct WildstringClientSuite {
        private let origin = "https://music.example.com"

        private func makeClient(store: InMemorySessionStore) throws -> WildstringClient {
            WildstringClient(
                server: try ServerAddress(input: "music.example.com"),
                store: store,
                configuration: StubURLProtocol.configuration()
            )
        }

        @Test func loginSendsIOSClientHeaderAndPersistsCookies() async throws {
            let userJSON =
                #"{"id":"admin","username":"admin","role":"admin","version":3,"enabled":true}"#
            let store = InMemorySessionStore()
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/auth/login")
                #expect(request.value(forHTTPHeaderField: "X-Wildstring-Client") == "ios")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: String]
                )
                #expect(json["username"] == "admin")
                #expect(json["password"] == "fixture-admin-password")
                return .json(
                    status: 200,
                    headers: [
                        "Set-Cookie":
                            "wildstring_session=token-123; Path=/; HttpOnly; Max-Age=604800"
                    ],
                    body: userJSON
                )
            }
            let client = try makeClient(store: store)
            let user = try await client.login(
                username: "admin",
                password: "fixture-admin-password"
            )
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
            let userJSON =
                #"{"id":"admin","username":"admin","role":"admin","version":3,"enabled":true}"#
            let store = InMemorySessionStore()
            StubURLProtocol.respond { request in
                let header = request.value(forHTTPHeaderField: "X-Wildstring-Client")
                if header == "web" {
                    return .json(status: 200, body: userJSON)
                }
                return .json(status: 403, body: #"{"detail":"client_header_required"}"#)
            }
            let client = try makeClient(store: store)
            let user = try await client.login(
                username: "admin",
                password: "fixture-admin-password"
            )
            #expect(user.username == "admin")
        }

        @Test func statusSendsStoredSessionCookie() async throws {
            let userJSON =
                #"{"id":"admin","username":"admin","role":"admin","version":3,"enabled":true}"#
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
                #expect(
                    request.value(forHTTPHeaderField: "Cookie")
                        == "wildstring_session=token-abc"
                )
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

        @Test func exposesCookieHeaderForAuxiliaryRequests() async throws {
            let store = InMemorySessionStore()
            try store.saveSession(
                StoredSession(cookies: [
                    StoredCookie(
                        name: "wildstring_session",
                        value: "token-xyz",
                        domain: "music.example.com",
                        path: "/"
                    ),
                ]),
                origin: origin
            )
            let client = try makeClient(store: store)
            let header = await client.cookieHeaderValue()
            #expect(header == "wildstring_session=token-xyz")
        }
    }

    @Suite("TracksAPI")
    struct TracksAPISuite {
        private func makeClient() throws -> WildstringClient {
            WildstringClient(
                server: try ServerAddress(input: "music.example.com"),
                store: InMemorySessionStore(),
                configuration: StubURLProtocol.configuration()
            )
        }

        @Test func tracksDecodesPageAndSendsPagingQuery() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "GET")
                #expect(request.url?.path == "/api/v1/tracks")
                #expect(request.url?.query == "limit=50&offset=0")
                return .json(
                    status: 200,
                    body: """
                        {"items":[{"id":"t1","title":"夜航","artists":["阿岚","小野"],"album":"夜航","duration_ms":215000,"has_cover":true,"play_count":3,"listened_ms":12000,"last_played_at":null,"loved":false,"format":"flac","status":"available","album_id":"a1","track_number":1,"disc_number":1}],"total":1,"limit":50,"offset":0}
                        """
                )
            }
            let page = try await makeClient().tracks()
            #expect(page.total == 1)
            let track = try #require(page.items.first)
            #expect(track.id == "t1")
            #expect(track.title == "夜航")
            #expect(track.artists == ["阿岚", "小野"])
            #expect(track.album == "夜航")
            #expect(track.durationMs == 215_000)
            #expect(track.hasCover)
            #expect(track.albumId == "a1")
            #expect(track.trackNumber == 1)
        }

        @Test func tracksEncodesSearchQuery() async throws {
            StubURLProtocol.respond { request in
                let query = request.url?.query ?? ""
                #expect(query.contains("q=%E5%A4%9C"))
                #expect(query.contains("limit=200"))
                return .json(status: 200, body: #"{"items":[],"total":0,"limit":200,"offset":0}"#)
            }
            _ = try await makeClient().tracks(limit: 200, query: "夜")
        }

        @Test func tracksRequiresSession() async throws {
            StubURLProtocol.respond { _ in
                .json(status: 401, body: #"{"detail":"authentication_required"}"#)
            }
            await #expect(throws: APIError(statusCode: 401, code: "authentication_required")) {
                try await makeClient().tracks()
            }
        }
    }

    @Suite("LibraryAPI")
    struct LibraryAPISuite {
        private func makeClient() throws -> WildstringClient {
            WildstringClient(
                server: try ServerAddress(input: "music.example.com"),
                store: InMemorySessionStore(),
                configuration: StubURLProtocol.configuration()
            )
        }

        @Test func albumsDecodePage() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/albums")
                #expect(request.url?.query == "limit=50&offset=0")
                return .json(
                    status: 200,
                    body: """
                        {"items":[{"id":"a1","title":"夜航","artists":["阿岚"],"track_count":9,"duration_ms":2400000,"cover_track_id":"t1"}],"total":1,"limit":50,"offset":0}
                        """
                )
            }
            let page = try await makeClient().albums()
            #expect(page.total == 1)
            let album = try #require(page.items.first)
            #expect(album.title == "夜航")
            #expect(album.trackCount == 9)
            #expect(album.coverTrackId == "t1")
        }

        @Test func albumTracksUseAlbumEndpoint() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/albums/a1/tracks")
                #expect(request.url?.query == "limit=200&offset=0")
                return .json(status: 200, body: #"{"items":[],"total":0,"limit":200,"offset":0}"#)
            }
            _ = try await makeClient().albumTracks(albumId: "a1")
        }

        @Test func artistsDecodePageAndQuery() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/artists")
                #expect(request.url?.query == "q=%E9%98%BF&limit=50&offset=0")
                return .json(
                    status: 200,
                    body: """
                        {"items":[{"id":"ar1","name":"阿岚","track_count":12,"album_count":2,"duration_ms":3000000,"cover_track_id":"t2"}],"total":1,"limit":50,"offset":0}
                        """
                )
            }
            let page = try await makeClient().artists(query: "阿")
            #expect(page.items.first?.name == "阿岚")
            #expect(page.items.first?.albumCount == 2)
        }

        @Test func artistAlbumsUseArtistEndpoint() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/artists/ar1/albums")
                return .json(status: 200, body: #"{"items":[],"total":0,"limit":50,"offset":0}"#)
            }
            _ = try await makeClient().artistAlbums(artistId: "ar1")
        }

        @Test func coverDataFetchesRawBytes() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/tracks/t1/cover")
                return .init(
                    statusCode: 200,
                    headers: ["Content-Type": "image/jpeg"],
                    body: Data([0xFF, 0xD8, 0xFF])
                )
            }
            let data = try await makeClient().authorizedData(path: "api/v1/tracks/t1/cover")
            #expect(data.count == 3)
        }
    }
}
