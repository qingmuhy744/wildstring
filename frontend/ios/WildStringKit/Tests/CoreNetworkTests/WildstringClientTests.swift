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

        @Test func lyricsDecodeSyncedLines() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/tracks/t1/lyrics")
                return .json(
                    status: 200,
                    body: """
                        {"kind":"synced","source":"file","lines":[{"time_ms":0,"text":"第一行"},{"time_ms":4000,"text":"第二行"}]}
                        """
                )
            }
            let lyrics = try await makeClient().lyrics(trackID: "t1")
            #expect(lyrics.kind == "synced")
            #expect(lyrics.isSynced)
            #expect(lyrics.lines.count == 2)
            #expect(lyrics.lines.first?.timeMs == 0)
            #expect(lyrics.lines.last?.text == "第二行")
            #expect(lyrics.source == "file")
        }

        @Test func lyricsNoneStaysPlayable() async throws {
            StubURLProtocol.respond { _ in
                .json(status: 200, body: #"{"kind":"none","lines":[]}"#)
            }
            let lyrics = try await makeClient().lyrics(trackID: "t9")
            #expect(lyrics.isEmpty)
            #expect(!lyrics.isSynced)
        }

        @Test func browseIndexDecodesGroups() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/browse-index")
                #expect(request.url?.query == "kind=tracks")
                return .json(
                    status: 200,
                    body: """
                        {"kind":"tracks","total":3,"groups":[{"key":"0–9","offset":null,"count":0},{"key":"A","offset":0,"count":1},{"key":"#","offset":2,"count":1}]}
                        """
                )
            }
            let index = try await makeClient().browseIndex()
            #expect(index.groups.count == 3)
            #expect(index.groups[1].offset == 0)
            #expect(index.groups[0].offset == nil)
        }
    }

    @Suite("PersonalLibrary")
    struct PersonalLibrarySuite {
        private func makeClient() throws -> WildstringClient {
            WildstringClient(
                server: try ServerAddress(input: "music.example.com"),
                store: InMemorySessionStore(),
                configuration: StubURLProtocol.configuration()
            )
        }

        @Test func playlistsDecodePage() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/playlists")
                #expect(request.url?.query == "limit=100&offset=0")
                return .json(
                    status: 200,
                    body: """
                        {"items":[{"id":"p1","name":"♥ 我喜欢","kind":"favorites","version":1,"created_at":1.0,"updated_at":2.0,"track_count":2,"duration_ms":20000,"cover_track_id":"t1","definition":null}],"total":1,"limit":100,"offset":0}
                        """
                )
            }
            let page = try await makeClient().playlists()
            let playlist = try #require(page.items.first)
            #expect(playlist.name == "♥ 我喜欢")
            #expect(playlist.isFavorites)
            #expect(!playlist.isEditable)
            #expect(playlist.trackCount == 2)
        }

        @Test func playlistTracksDecodePage() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/playlists/p1/tracks")
                #expect(request.url?.query == "limit=200&offset=0")
                return .json(status: 200, body: #"{"items":[],"total":0,"limit":200,"offset":0}"#)
            }
            _ = try await makeClient().playlistTracks(playlistID: "p1")
        }

        @Test func favoriteIDsDecode() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/favorites/ids")
                return .json(status: 200, body: #"{"ids":["t1","t2"]}"#)
            }
            let ids = try await makeClient().favoriteIDs()
            #expect(ids == ["t1", "t2"])
        }

        @Test func setFavoriteSendsLovedFlag() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "PUT")
                #expect(request.url?.path == "/api/v1/tracks/t1/favorite")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Bool]
                )
                #expect(json["loved"] == true)
                return .json(status: 200, body: #"{"loved":true}"#)
            }
            try await makeClient().setFavorite(trackID: "t1", loved: true)
        }

        @Test func createPlaylistSendsNameAndKind() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/playlists")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: String]
                )
                #expect(json["name"] == "通勤")
                #expect(json["kind"] == "manual")
                return .json(
                    status: 201,
                    body: """
                        {"id":"p2","name":"通勤","kind":"manual","version":1,"track_count":0,"duration_ms":0,"cover_track_id":"","definition":null}
                        """
                )
            }
            let created = try await makeClient().createPlaylist(name: "通勤")
            #expect(created.id == "p2")
            #expect(created.isEditable)
        }

        @Test func addTracksSendsVersionAndIDs() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/playlists/p2/tracks")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["version"] as? Int == 3)
                #expect(json["track_ids"] as? [String] == ["t1", "t2"])
                return .empty(status: 204)
            }
            try await makeClient().addTracks(playlistID: "p2", trackIDs: ["t1", "t2"], version: 3)
        }

        @Test func removeTrackUsesQueryVersion() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "DELETE")
                #expect(request.url?.path == "/api/v1/playlists/p2/tracks/t1")
                #expect(request.url?.query == "version=4")
                return .empty(status: 204)
            }
            try await makeClient().removeTrack(playlistID: "p2", trackID: "t1", version: 4)
        }

        @Test func reorderTracksSendsVersionAndIDs() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "PUT")
                #expect(request.url?.path == "/api/v1/playlists/p2/order")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["version"] as? Int == 6)
                #expect(json["track_ids"] as? [String] == ["t2", "t1"])
                return .empty(status: 204)
            }
            try await makeClient().reorderTracks(
                playlistID: "p2",
                trackIDs: ["t2", "t1"],
                version: 6
            )
        }

        @Test func deletePlaylistUsesQueryVersion() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "DELETE")
                #expect(request.url?.path == "/api/v1/playlists/p2")
                #expect(request.url?.query == "version=5")
                return .empty(status: 204)
            }
            try await makeClient().deletePlaylist(playlistID: "p2", version: 5)
        }

        @Test func renamePlaylistSendsVersionAndKind() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "PUT")
                #expect(request.url?.path == "/api/v1/playlists/p2")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["name"] as? String == "改名")
                #expect(json["version"] as? Int == 2)
                #expect(json["kind"] as? String == "manual")
                return .json(
                    status: 200,
                    body: """
                        {"id":"p2","name":"改名","kind":"manual","version":3,"track_count":0,"duration_ms":0,"cover_track_id":"","definition":null}
                        """
                )
            }
            let updated = try await makeClient().renamePlaylist(
                id: "p2",
                name: "改名",
                version: 2,
                kind: "manual"
            )
            #expect(updated.name == "改名")
            #expect(updated.version == 3)
        }

        @Test func versionConflictSurfacesStableCode() async throws {
            StubURLProtocol.respond { _ in
                .json(status: 409, body: #"{"detail":"playlist_version_conflict"}"#)
            }
            await #expect(throws: APIError(statusCode: 409, code: "playlist_version_conflict")) {
                try await makeClient().addTracks(playlistID: "p2", trackIDs: ["t1"], version: 1)
            }
        }

        @Test func dailyRecommendationsDecode() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/recommendations/daily")
                return .json(
                    status: 200,
                    body: """
                        {"id":"r1","date":"2026-10-19","engine":"local","degraded":false,"items":[{"track":{"id":"t1","title":"歌","artists":["人"],"album":"集","duration_ms":1000,"has_cover":false,"play_count":0,"listened_ms":0,"last_played_at":null,"loved":false,"format":"mp3","status":"available","album_id":"a1","track_number":1,"disc_number":1},"reason":"常听","source_ids":[]}]}
                        """
                )
            }
            let daily = try await makeClient().dailyRecommendations()
            #expect(daily.items.count == 1)
            #expect(daily.items.first?.track.title == "歌")
            #expect(daily.items.first?.reason == "常听")
        }

        @Test func refreshDailyUsesRefreshEndpoint() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/recommendations/daily/refresh")
                return .json(status: 200, body: #"{"id":"r2","date":"2026-10-19","items":[]}"#)
            }
            let daily = try await makeClient().refreshDailyRecommendations()
            #expect(daily.id == "r2")
        }
    }

    @Suite("Agent")
    struct AgentSuite {
        private func makeClient() throws -> WildstringClient {
            WildstringClient(
                server: try ServerAddress(input: "music.example.com"),
                store: InMemorySessionStore(),
                configuration: StubURLProtocol.configuration()
            )
        }

        @Test func draftsDecodeList() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/agent/drafts")
                #expect(request.url?.query == "limit=50&offset=0")
                return .json(
                    status: 200,
                    body: """
                        {"items":[{"id":"d1","kind":"playlist","title":"晚安歌单","payload":{"name":"晚安歌单","track_ids":["t1","t2"]},"evidence":[{"source":"assistant","summary":"按安静氛围挑选","url":null}],"status":"pending","version":1,"approved_version":null,"result":null}],"total":1,"limit":50,"offset":0}
                        """
                )
            }
            let page = try await makeClient().drafts()
            let draft = try #require(page.items.first)
            #expect(draft.title == "晚安歌单")
            #expect(draft.isPending)
            #expect(draft.payload?.trackIds == ["t1", "t2"])
            #expect(draft.evidence.first?.summary == "按安静氛围挑选")
        }

        @Test func approveDraftSendsVersion() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/agent/drafts/d1/approve")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Int]
                )
                #expect(json["version"] == 1)
                return .json(
                    status: 200,
                    body: """
                        {"id":"d1","kind":"playlist","title":"晚安歌单","status":"approved","version":1,"approved_version":1,"payload":{"name":"晚安歌单","track_ids":["t1"]},"evidence":[],"result":null}
                        """
                )
            }
            let draft = try await makeClient().approveDraft(id: "d1", version: 1)
            #expect(draft.status == "approved")
        }

        @Test func applyDraftSendsIdempotencyKey() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/agent/drafts/d1/apply")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["version"] as? Int == 1)
                #expect((json["idempotency_key"] as? String)?.hasPrefix("ios-") == true)
                return .json(
                    status: 200,
                    body: """
                        {"id":"d1","kind":"playlist","title":"晚安歌单","status":"applied","version":1,"payload":null,"evidence":[],"result":{"playlist_id":"p9"}}
                        """
                )
            }
            let draft = try await makeClient().applyDraft(id: "d1", version: 1)
            #expect(draft.status == "applied")
            #expect(draft.result?.playlistId == "p9")
        }

        @Test func sendMessageDecodesConversation() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/agent/conversations/c1/messages")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["content"] as? String == "帮我找安静的钢琴曲")
                return .json(
                    status: 200,
                    body: """
                        {"id":"c1","title":"找一个歌单","messages":[{"id":"m1","role":"user","content":"帮我找安静的钢琴曲","partial":false},{"id":"m2","role":"assistant","content":"本次使用本地关键词检索，未调用模型。","partial":false}]}
                        """
                )
            }
            let detail = try await makeClient().sendMessage(
                conversationID: "c1",
                content: "帮我找安静的钢琴曲"
            )
            #expect(detail.messages.count == 2)
            #expect(detail.messages.first?.isUser == true)
            #expect(detail.messages.last?.content.contains("本地关键词检索") == true)
        }

        @Test func createConversationDecodesDetail() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/agent/conversations")
                return .json(status: 200, body: #"{"id":"c2","title":"新对话","messages":[]}"#)
            }
            let detail = try await makeClient().createConversation()
            #expect(detail.id == "c2")
            #expect(detail.messages.isEmpty)
        }
    }

    @Suite("Admin")
    struct AdminSuite {
        private func makeClient() throws -> WildstringClient {
            WildstringClient(
                server: try ServerAddress(input: "music.example.com"),
                store: InMemorySessionStore(),
                configuration: StubURLProtocol.configuration()
            )
        }

        @Test func scansDecodeBareArray() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/scans")
                #expect(request.url?.query == "limit=20")
                return .json(
                    status: 200,
                    body: """
                        [{"id":"s1","status":"completed","started_at":"2026-10-19T08:00:00+00:00","finished_at":"2026-10-19T08:00:01+00:00","counts":{"visited":2,"added":2,"updated":0,"unchanged":0,"errors":0,"missing":0,"skipped":2},"errors":[]}]
                        """
                )
            }
            let scans = try await makeClient().scans()
            let scan = try #require(scans.first)
            #expect(scan.status == "completed")
            #expect(scan.counts?.added == 2)
            #expect(scan.errors?.isEmpty == true)
        }

        @Test func importsDecodeBareArray() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/imports")
                return .json(status: 200, body: #"[{"id":"i1","status":"completed","counts":{"copied":3},"errors":[]}]"#)
            }
            let imports = try await makeClient().imports()
            #expect(imports.first?.id == "i1")
            #expect(imports.first?.counts?["copied"] == 3)
        }

        @Test func metadataDecodeAndUpdateSendsOnlyChanges() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/manage/tracks/t1/metadata")
                return .json(
                    status: 200,
                    body: """
                        {"track_id":"t1","version":3,"observed":{"title":"晴天测试曲","artists":["野弦测试"],"album":"合成测试专辑","album_artists":["野弦测试"],"track_number":1,"disc_number":null,"description":""},"overrides":{},"effective":{}}
                        """
                )
            }
            let metadata = try await makeClient().manageMetadata(trackID: "t1")
            #expect(metadata.version == 3)
            #expect(metadata.observed.title == "晴天测试曲")
            #expect(metadata.observed.albumArtists == ["野弦测试"])

            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "PUT")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["version"] as? Int == 3)
                let overrides = try #require(json["overrides"] as? [String: Any])
                #expect(overrides["description"] as? String == "新描述")
                #expect(overrides["title"] == nil)
                return .json(
                    status: 200,
                    body: """
                        {"track_id":"t1","version":4,"observed":{"title":"晴天测试曲"},"overrides":{"description":"新描述"},"effective":{}}
                        """
                )
            }
            var overrides = MetadataOverrides()
            overrides.description = "新描述"
            let updated = try await makeClient().updateMetadata(
                trackID: "t1",
                version: 3,
                overrides: overrides
            )
            #expect(updated.version == 4)
        }

        @Test func managedLyricsDecodeAndSave() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/manage/tracks/t1/lyrics")
                return .json(
                    status: 200,
                    body: """
                        {"track_id":"t1","version":1,"file_version":"abc","override":null,"observed_text":"[00:00.000]第一行","text":"[00:00.000]第一行"}
                        """
                )
            }
            let lyrics = try await makeClient().managedLyrics(trackID: "t1")
            #expect(lyrics.fileVersion == "abc")
            #expect(lyrics.override == nil)

            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "PUT")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["version"] as? Int == 1)
                #expect(json["file_version"] as? String == "abc")
                #expect(json["text"] as? String == "[00:00.000]改过的第一行")
                return .json(
                    status: 200,
                    body: """
                        {"track_id":"t1","version":2,"file_version":"abc","override":"[00:00.000]改过的第一行","observed_text":"[00:00.000]第一行","text":"[00:00.000]改过的第一行"}
                        """
                )
            }
            let saved = try await makeClient().saveLyrics(
                trackID: "t1",
                text: "[00:00.000]改过的第一行",
                version: 1,
                fileVersion: "abc"
            )
            #expect(saved.version == 2)
            #expect(saved.override == "[00:00.000]改过的第一行")
        }

        @Test func restoreFileLyricsSendsNullText() async throws {
            StubURLProtocol.respond { request in
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["text"] is NSNull)
                return .json(
                    status: 200,
                    body: """
                        {"track_id":"t1","version":3,"file_version":"abc","override":null,"observed_text":"x","text":"x"}
                        """
                )
            }
            _ = try await makeClient().saveLyrics(
                trackID: "t1",
                text: nil,
                version: 2,
                fileVersion: "abc"
            )
        }
    }
}
