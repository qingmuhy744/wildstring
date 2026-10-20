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
                let items = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?
                    .queryItems ?? []
                let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
                #expect(values["limit"] == "50")
                #expect(values["offset"] == "0")
                #expect(values["sort"] == "title")
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
                let items = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?
                    .queryItems ?? []
                let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
                #expect(values["limit"] == "50")
                #expect(values["offset"] == "0")
                #expect(values["sort"] == "title")
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
                let items = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?
                    .queryItems ?? []
                let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
                #expect(values["limit"] == "200")
                #expect(values["offset"] == "0")
                #expect(values["sort"] == "track_number")
                #expect(values["order"] == nil)
                return .json(status: 200, body: #"{"items":[],"discs":[],"total":0,"limit":200,"offset":0}"#)
            }
            _ = try await makeClient().albumTracks(albumId: "a1")
        }

        @Test func albumTracksDecodeDiscSummaries() async throws {
            StubURLProtocol.respond { request in
                let items = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?
                    .queryItems ?? []
                let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
                #expect(values["sort"] == "added_at")
                #expect(values["order"] == "desc")
                return .json(
                    status: 200,
                    body: """
                        {"items":[{"id":"t1","title":"甲","artists":["A"],"album":"集","duration_ms":1000,"has_cover":false,"album_id":"a1","track_number":1,"disc_number":1}],"discs":[{"number":1,"track_count":2,"duration_ms":2000,"offset":0},{"number":2,"track_count":3,"duration_ms":3000,"offset":2}],"total":5,"limit":200,"offset":0}
                        """
                )
            }
            let page = try await makeClient().albumTracks(
                albumId: "a1",
                sort: .addedAt,
                order: .desc
            )
            #expect(page.items.count == 1)
            #expect(page.discs.count == 2)
            #expect(page.discs[1].number == 2)
            #expect(page.discs[1].offset == 2)
            #expect(page.discs[0].trackCount == 2)
        }

        @Test func libraryTracksSendSortAndOrder() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/tracks")
                let items = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?
                    .queryItems ?? []
                let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
                #expect(values["sort"] == "last_played_at")
                #expect(values["order"] == "desc")
                return .json(status: 200, body: #"{"items":[],"discs":[],"total":0,"limit":100,"offset":0}"#)
            }
            _ = try await makeClient().tracks(
                limit: 100,
                offset: 0,
                sort: .lastPlayed,
                order: .desc
            )
        }

        @Test func libraryAlbumsSendSortAndOrder() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/albums")
                let items = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?
                    .queryItems ?? []
                let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
                #expect(values["sort"] == "release_date")
                #expect(values["order"] == "desc")
                return .json(status: 200, body: #"{"items":[],"total":0,"limit":50,"offset":0}"#)
            }
            _ = try await makeClient().albums(sort: .releaseDate, order: .desc)
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

        @Test func playbackPlanDecodesTranscodeDecision() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/tracks/t1/playback")
                #expect(request.url?.query == "format=aac&bitrate_kbps=192&start_ms=53000")
                return .json(
                    status: 200,
                    body: """
                        {"mode":"transcode","reason":"lossless_to_aac","output":{"codec":"aac","container":"m4a","bitrate_kbps":192},"duration_ms":285000,"start_ms":53000,"cache_state":"miss","stream_url":"/api/v1/tracks/t1/stream?format=aac&bitrate_kbps=192&start_ms=53000"}
                        """
                )
            }
            let plan = try await makeClient().playbackPlan(
                trackID: "t1",
                bitrateKbps: 192,
                startMs: 53000
            )
            #expect(plan.isTranscode)
            #expect(plan.durationMs == 285_000)
            #expect(plan.startMs == 53_000)
            #expect(plan.output.codec == "aac")
            #expect(plan.streamUrl.contains("format=aac"))
        }

        @Test func playbackPlanOriginalHasNoQuery() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.query == nil)
                return .json(
                    status: 200,
                    body: """
                        {"mode":"original","reason":"original_requested","output":{"codec":"flac","container":"flac","bitrate_kbps":1100},"duration_ms":285000,"start_ms":0,"stream_url":"/api/v1/tracks/t1/stream"}
                        """
                )
            }
            let plan = try await makeClient().playbackPlan(trackID: "t1", bitrateKbps: nil)
            #expect(!plan.isTranscode)
        }

        @Test func playbackStateDecodeInitial() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/playback/state")
                return .json(
                    status: 200,
                    body: """
                        {"version":0,"device_id":"","track_ids":[],"index":0,"position_ms":0,"mode":"sequential","updated_at":null}
                        """
                )
            }
            let state = try await makeClient().playbackState()
            #expect(state.version == 0)
            #expect(state.trackIds.isEmpty)
            #expect(state.mode == "sequential")
        }

        @Test func savePlaybackStateSendsSnapshot() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "PUT")
                #expect(request.url?.path == "/api/v1/playback/state")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["version"] as? Int == 3)
                #expect(json["device_id"] as? String == "ios-device")
                #expect(json["track_ids"] as? [String] == ["t1", "t2"])
                #expect(json["index"] as? Int == 1)
                #expect(json["position_ms"] as? Int == 42_000)
                #expect(json["mode"] as? String == "shuffle")
                #expect(json["playback_state"] as? String == "paused")
                return .json(
                    status: 200,
                    body: """
                        {"version":4,"device_id":"ios-device","track_ids":["t1","t2"],"index":1,"position_ms":42000,"mode":"shuffle","updated_at":"2026-10-19T10:00:00+00:00","playback_state":"paused","paused_at":"2026-10-19T10:00:00+00:00","handoff_supported":true,"handoff_eligible":true}
                        """
                )
            }
            let saved = try await makeClient().savePlaybackState(
                RemotePlaybackState(
                    version: 3,
                    deviceId: "ios-device",
                    trackIds: ["t1", "t2"],
                    index: 1,
                    positionMs: 42_000,
                    mode: "shuffle",
                    playbackState: "paused"
                )
            )
            #expect(saved.version == 4)
            #expect(saved.playbackState == "paused")
            #expect(saved.handoffEligible == true)
            #expect(saved.pausedAt == "2026-10-19T10:00:00+00:00")
        }

        @Test func playbackStateDecodesHandoffEligibility() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/playback/state")
                return .json(
                    status: 200,
                    body: """
                        {"version":7,"device_id":"android","track_ids":["t1"],"index":0,"position_ms":1000,"mode":"sequential","updated_at":"2026-10-20T08:00:00+00:00","playback_state":"paused","paused_at":"2026-10-20T07:59:00+00:00","handoff_supported":true,"handoff_eligible":true}
                        """
                )
            }
            let state = try await makeClient().playbackState()
            #expect(state.playbackState == "paused")
            #expect(state.handoffSupported == true)
            #expect(state.handoffEligible == true)
            #expect(state.pausedAt == "2026-10-20T07:59:00+00:00")
        }

        @Test func singleTrackFetchesByID() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/tracks/t1")
                return .json(
                    status: 200,
                    body: """
                        {"id":"t1","title":"歌","artists":["人"],"album":"集","duration_ms":1000,"has_cover":false,"album_id":null,"track_number":null,"disc_number":null}
                        """
                )
            }
            let track = try await makeClient().track(id: "t1")
            #expect(track.title == "歌")
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

        @Test func metadataReviewDecodesCandidatesAndDuplicates() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/agent/metadata-review")
                let items = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?
                    .queryItems ?? []
                let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
                #expect(values["album_id"] == "a1")
                #expect(values["limit"] == "500")
                return .json(
                    status: 200,
                    body: """
                        {"items":[{"id":"t1","title":"甲","album":"集","album_id":"a1","artists":["A"],"disc_number":1,"track_number":2,"has_cover":true,"metadata_version":4,"current":{"title":"甲","artists":["A"],"external_ids":{"release":"r1"}},"original":{"title":"甲"},"overrides":{},"suggestions":[{"id":"s1","track_id":"t1","metadata_version":4,"provider":"musicbrainz","cover_url":null,"fields":{"title":"甲（重制）","track_number":2},"match":{"method":"acoustid","score":0.9},"source_url":"https://musicbrainz.org/recording/x","candidate_digest":"digest-1","duplicate_count":2}]}],"total":1,"limit":500,"offset":0,"album_id":"a1","provider_names":{"musicbrainz":"MusicBrainz"}}
                        """
                )
            }
            let page = try await makeClient().metadataReview(albumID: "a1")
            let track = try #require(page.items.first)
            #expect(track.metadataVersion == 4)
            #expect(track.current["title"]?.display == "甲")
            #expect(track.current["external_ids"]?.display == "release：r1")
            let candidate = try #require(track.suggestions.first)
            #expect(candidate.candidateDigest == "digest-1")
            #expect(candidate.duplicateCount == 2)
            #expect(candidate.fields["track_number"]?.display == "2")
            #expect(page.providerNames["musicbrainz"] == "MusicBrainz")
        }

        @Test func acceptReviewSendsDigestsFieldsAndCover() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/agent/metadata-review/accept")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["cover_draft_id"] as? String == "cover-draft")
                #expect(json["idempotency_key"] as? String == "review-key")
                let items = try #require(json["items"] as? [[String: Any]])
                #expect(items.first?["track_id"] as? String == "t1")
                #expect(items.first?["suggestion_id"] as? String == "s1")
                #expect(items.first?["metadata_version"] as? Int == 4)
                #expect(items.first?["candidate_digest"] as? String == "digest-1")
                #expect(items.first?["fields"] as? [String] == ["title"])
                return .json(
                    status: 200,
                    body: """
                        {"status":"applied","draft":{"id":"d1","kind":"metadata_batch","title":"批量核对资料 · 1 首","status":"applied","version":2,"approved_version":2,"payload":{"items":[]},"evidence":[],"result":null,"preview_digest":"abc"}}
                        """
                )
            }
            let result = try await makeClient().acceptReview(
                items: [
                    ReviewAcceptItem(
                        trackID: "t1",
                        suggestionID: "s1",
                        metadataVersion: 4,
                        candidateDigest: "digest-1",
                        fields: ["title"]
                    )
                ],
                coverDraftID: "cover-draft",
                idempotencyKey: "review-key"
            )
            #expect(result.status == "applied")
            #expect(result.draft?.previewDigest == "abc")
        }

        @Test func rejectReviewSendsCandidateDigest() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/agent/metadata-review/reject")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["track_id"] as? String == "t1")
                #expect(json["suggestion_id"] as? String == "s1")
                #expect(json["metadata_version"] as? Int == 4)
                #expect(json["candidate_digest"] as? String == "digest-1")
                return .json(
                    status: 200,
                    body: #"{"status":"ignored","ignored_count":2,"already_ignored":false}"#
                )
            }
            let result = try await makeClient().rejectReview(
                trackID: "t1",
                suggestionID: "s1",
                metadataVersion: 4,
                candidateDigest: "digest-1"
            )
            #expect(result.ignoredCount == 2)
        }

        @Test func applicationPolicyRoundTrip() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/agent/application-policy")
                return .json(
                    status: 200,
                    body: #"{"mode":"manual","kinds":["playlist"],"version":3,"allowed_kinds":["playlist","metadata","metadata_batch","cover","lyrics","intake"]}"#
                )
            }
            let policy = try await makeClient().applicationPolicy()
            #expect(policy.version == 3)
            #expect(policy.allowedKinds.contains("metadata"))

            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "PUT")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["mode"] as? String == "automatic")
                #expect(json["kinds"] as? [String] == ["metadata_batch"])
                #expect(json["version"] as? Int == 3)
                return .json(
                    status: 200,
                    body: #"{"mode":"automatic","kinds":["metadata_batch"],"version":4,"allowed_kinds":["metadata_batch"]}"#
                )
            }
            let saved = try await makeClient().saveApplicationPolicy(
                mode: "automatic",
                kinds: ["metadata_batch"],
                version: 3
            )
            #expect(saved.version == 4)
        }

        @Test func reviewCoverDraftSendsSnapshotTargets() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/agent/metadata-review/cover")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["kind"] as? String == "cover")
                let payload = try #require(json["payload"] as? [String: Any])
                #expect(payload["suggestion_id"] as? String == "s1")
                #expect(payload["metadata_version"] as? Int == 4)
                let targets = try #require(payload["targets"] as? [[String: Any]])
                #expect(targets.first?["track_id"] as? String == "t1")
                #expect(targets.first?["metadata_version"] as? Int == 4)
                return .json(
                    status: 200,
                    body: """
                        {"id":"cover-draft","kind":"cover","title":"封面核对 · 集","status":"pending","version":1,"approved_version":null,"payload":{"suggestion_id":"s1","metadata_version":4,"targets":[]},"evidence":[],"result":null,"preview_digest":"abc"}
                        """
                )
            }
            let draft = try await makeClient().reviewCoverDraft(
                title: "封面核对 · 集",
                suggestionID: "s1",
                metadataVersion: 4,
                targets: [ReviewCoverTarget(trackID: "t1", metadataVersion: 4)]
            )
            #expect(draft.id == "cover-draft")
            #expect(draft.previewDigest == "abc")
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

        @Test func providerSuggestionsDecodeFieldsAndMatches() async throws {
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/manage/providers/tracks/t1")
                return .json(
                    status: 200,
                    body: """
                        {"suggestions":[{"id":"s1","job_id":"j1","track_id":"t1","metadata_version":3,"provider":"musicbrainz","source_url":"https://musicbrainz.org/release/x","fields":{"title":"新标题","artists":["甲","乙"],"track_number":4},"cover_url":"https://coverartarchive.org/release/x/1.jpg","status":"pending","created_at":123.0,"match":{"method":"acoustid","score":0.92}}],"jobs":[{"id":"j1","track_id":"t1","status":"running","refresh_mode":"missing","error":""}],"provider_names":{"musicbrainz":"MusicBrainz"}}
                        """
                )
            }
            let results = try await makeClient().providerSuggestions(trackID: "t1")
            let suggestion = try #require(results.suggestions.first)
            #expect(suggestion.status == "pending")
            #expect(suggestion.metadataVersion == 3)
            #expect(suggestion.fields["artists"]?.display == "甲、乙")
            #expect(suggestion.fields["track_number"]?.display == "4")
            #expect(suggestion.match?.score == 0.92)
            #expect(suggestion.coverURL == "https://coverartarchive.org/release/x/1.jpg")
            #expect(results.providerNames["musicbrainz"] == "MusicBrainz")
            #expect(results.jobs.first?.status == "running")
        }

        @Test func refreshProviderTrackSendsScopeModeAndForce() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/manage/providers/refresh")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["scope"] as? String == "track")
                #expect(json["id"] as? String == "t1")
                #expect(json["mode"] as? String == "all")
                #expect(json["force"] as? Bool == true)
                return .json(
                    status: 200,
                    body: #"{"queued":1,"already_active":0,"total":1}"#
                )
            }
            let result = try await makeClient().refreshProviderMetadata(
                trackID: "t1",
                mode: "all",
                force: true
            )
            #expect(result.queued == 1)
            #expect(result.alreadyActive == 0)
        }

        @Test func applyProviderSuggestionSendsChosenFields() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/manage/providers/suggestions/s1/apply")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["version"] as? Int == 3)
                #expect(json["fields"] as? [String] == ["title", "album"])
                return .json(
                    status: 200,
                    body: """
                        {"track_id":"t1","version":4,"observed":{"title":"旧标题"},"overrides":{"title":"新标题"},"effective":{"title":"新标题"}}
                        """
                )
            }
            let saved = try await makeClient().applyProviderSuggestion(
                id: "s1",
                version: 3,
                fields: ["title", "album"]
            )
            #expect(saved.version == 4)
        }

        @Test func applyProviderCoverSendsVersion() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/api/v1/manage/providers/suggestions/s1/cover")
                let body = try #require(StubURLProtocol.bodyData(of: request))
                let json = try #require(
                    try JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                #expect(json["version"] as? Int == 3)
                return .json(status: 200, body: #"{"applied":true}"#)
            }
            try await makeClient().applyProviderCover(suggestionID: "s1", version: 3)
        }

        @Test func coverPreviewReturnsRawImageData() async throws {
            let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
            StubURLProtocol.respond { request in
                #expect(request.url?.path == "/api/v1/manage/providers/suggestions/s1/cover-preview")
                return StubURLProtocol.Stub(
                    statusCode: 200,
                    headers: ["Content-Type": "image/jpeg"],
                    body: jpeg
                )
            }
            let data = try await makeClient().providerCoverPreview(suggestionID: "s1")
            #expect(data == jpeg)
        }
    }
}
