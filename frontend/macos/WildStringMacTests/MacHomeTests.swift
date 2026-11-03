import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI
import Testing
@testable import WildString

extension MacAssistantTests {
    @Test func homeLoadsNewArrivalsSeparatelyFromHistoryAndKeepsTheQueue() async throws {
        let track = #"{"id":"new-song","title":"新加入的歌","artists":["测试艺人"],"duration_ms":120000,"has_cover":false}"#
        let history = #"{"id":"history-song","title":"上次听过的歌","artists":["测试艺人"],"duration_ms":180000,"has_cover":false}"#
        StubURLProtocol.respond { request in
            let url = request.url!
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems ?? []
            #expect(request.httpMethod == "GET")
            switch url.path {
            case "/api/v1/albums":
                #expect(query.contains(URLQueryItem(name: "sort", value: "added_at")))
                #expect(query.contains(URLQueryItem(name: "order", value: "desc")))
                return .json(body: #"{"items":[{"id":"album-new","title":"刚刚加入收藏","artists":["测试艺人"],"track_count":8,"duration_ms":960000,"cover_track_id":""}],"total":1,"limit":10,"offset":0}"#)
            case "/api/v1/tracks":
                #expect(query.contains(URLQueryItem(name: "order", value: "desc")))
                let recent = query.contains(URLQueryItem(name: "played_only", value: "true"))
                #expect(query.contains(URLQueryItem(name: "sort", value: recent ? "last_played_at" : "added_at")))
                return .json(body: "{\"items\":[\(recent ? history : track)],\"total\":1,\"limit\":6,\"offset\":0}")
            case "/api/v1/recommendations/daily":
                return .json(body: "{\"id\":\"daily\",\"date\":\"2026-11-01\",\"items\":[{\"track\":\(track),\"reason\":\"来自你的曲库\"}]}")
            default: return .empty(status: 404)
            }
        }
        let client = WildstringClient(server: try ServerAddress(input: "music.example.com"),
            store: InMemorySessionStore(), configuration: StubURLProtocol.configuration())
        let model = MacHomeModel(client: client)
        await model.load()
        #expect(model.albums.map(\.id) == ["album-new"])
        #expect(model.added.map(\.id) == ["new-song"])
        #expect(model.recent.map(\.id) == ["history-song"])
        #expect(model.daily?.items.count == 1)
        #expect(model.error == nil)

        let session = MacSession()
        #expect(session.page == .home)
        let playback = PlaybackService(server: client.server, store: InMemoryQueueStore(), cookieHeader: { nil })
        let current = PlaybackService.Item(trackID: "current", title: "正在听的歌", artist: "测试艺人", streamPath: "unused")
        playback.adopt(items: [current], startingAt: 0, position: 32.289, mode: "sequential")
        defer { playback.shutdown() }
        let host = NSHostingView(rootView: NavigationStack {
            MacHomeView(session: session, client: client, playback: playback)
                .background(Color(nsColor: .windowBackgroundColor))
        }.preferredColorScheme(.light))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1050, height: 850), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(500))
        host.layoutSubtreeIfNeeded()
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try #require(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: "/tmp/wildstring-mac-home.png"))
        window.setContentSize(NSSize(width: 510, height: 850))
        host.rootView = NavigationStack {
            MacHomeView(session: session, client: client, playback: playback)
                .background(Color(nsColor: .windowBackgroundColor))
        }.preferredColorScheme(.dark)
        try await Task.sleep(for: .milliseconds(300))
        host.layoutSubtreeIfNeeded()
        let narrow = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: narrow)
        try #require(narrow.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: "/tmp/wildstring-mac-home-narrow.png"))
        #expect(playback.currentItem?.trackID == "current")
        #expect(playback.currentTime == 32.289)
        #expect(!playback.isPlaying)
    }

    @Test func unavailableRecommendationsLeaveHomeLibraryUsable() async throws {
        StubURLProtocol.respond { request in
            if request.url!.path == "/api/v1/recommendations/daily" { return .empty(status: 503) }
            return .json(body: #"{"items":[],"total":0,"limit":10,"offset":0}"#)
        }
        let client = WildstringClient(server: try ServerAddress(input: "music.example.com"),
            store: InMemorySessionStore(), configuration: StubURLProtocol.configuration())
        let model = MacHomeModel(client: client)
        await model.load()
        #expect(!model.loading)
        #expect(model.error == nil)
        #expect(model.recommendationError != nil)
    }

    @Test func playableTracksShowArtistAndAlbumColumnsAndFavoritesKeepToolbarStable() async throws {
        let trackJSON = #"{"id":"song-1","title":"一无所有","artists":["崔健"],"album":"新长征路上的摇滚","album_id":"album-1","duration_ms":332000,"has_cover":false}"#
        StubURLProtocol.respond { request in
            switch request.url!.path {
            case "/api/v1/tracks":
                return .json(body: "{\"items\":[\(trackJSON)],\"total\":1,\"limit\":200,\"offset\":0}")
            case "/api/v1/playlists":
                return .json(body: #"{"items":[{"id":"fav","name":"我喜欢","kind":"favorites","track_count":1,"duration_ms":332000,"version":1}],"total":1,"limit":100,"offset":0}"#)
            case "/api/v1/playlists/fav/tracks":
                return .json(body: "{\"items\":[\(trackJSON)],\"total\":1,\"limit\":200,\"offset\":0}")
            case "/api/v1/favorites/ids":
                return .json(body: #"{"ids":["song-1"]}"#)
            default:
                return .json(body: #"{"items":[],"total":0,"limit":100,"offset":0}"#)
            }
        }
        let client = WildstringClient(server: try ServerAddress(input: "music.example.com"),
            store: InMemorySessionStore(), configuration: StubURLProtocol.configuration())
        let playback = PlaybackService(server: client.server, store: InMemoryQueueStore(), cookieHeader: { nil })
        defer { playback.shutdown() }
        let favorites = MacFavorites(client: client)
        await favorites.load()
        let track = try JSONDecoder().decode(Track.self, from: Data(trackJSON.utf8))

        let host = NSHostingView(rootView: AnyView(NavigationStack {
            MacPlayableTracks(
                client: client,
                playback: playback,
                favorites: favorites,
                tracks: [track],
                emptyTitle: "空"
            )
            .toolbar {
                ToolbarItem(placement: .automatic) {
                    Color.clear.frame(width: 1, height: 1)
                }
            }
        }))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 640),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(250))
        host.layoutSubtreeIfNeeded()
        let tracksLayoutRect = window.contentLayoutRect

        host.rootView = AnyView(NavigationStack {
            MacFavoritesView(client: client, playback: playback, favorites: favorites, canManage: false)
                .toolbar {
                    ToolbarItem(placement: .automatic) {
                        Color.clear.frame(width: 1, height: 1)
                    }
                }
        })
        try await Task.sleep(for: .milliseconds(250))
        host.layoutSubtreeIfNeeded()
        let favoritesLayoutRect = window.contentLayoutRect
        #expect(tracksLayoutRect == favoritesLayoutRect)
    }

    @Test func appearanceSwitchingFromAutoToLightAndBackRestoresSystemAppearance() throws {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 320),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.orderFront(nil)
        defer {
            MacAppearance.apply(UserDefaults.standard.string(forKey: "macAppearance") ?? "system")
            window.close()
        }

        // System dark (evening): Auto -> Light -> Auto must restore darkAqua on both app and window.
        MacAppearance.apply("system", systemDark: true)
        #expect(MacAppearance.resolvedColorScheme(for: "system", systemDark: true) == .dark)
        #expect(window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)

        MacAppearance.apply("light", systemDark: true)
        #expect(MacAppearance.resolvedColorScheme(for: "light", systemDark: true) == .light)
        #expect(window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .aqua)

        MacAppearance.apply("system", systemDark: true)
        #expect(MacAppearance.resolvedColorScheme(for: "system", systemDark: true) == .dark)
        #expect(window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)

        // System light (daytime): Auto -> Dark -> Auto must restore aqua on both app and window.
        MacAppearance.apply("system", systemDark: false)
        #expect(MacAppearance.resolvedColorScheme(for: "system", systemDark: false) == .light)
        #expect(window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .aqua)

        MacAppearance.apply("dark", systemDark: false)
        #expect(MacAppearance.resolvedColorScheme(for: "dark", systemDark: false) == .dark)
        #expect(window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)

        MacAppearance.apply("system", systemDark: false)
        #expect(MacAppearance.resolvedColorScheme(for: "system", systemDark: false) == .light)
        #expect(window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .aqua)
    }
}
