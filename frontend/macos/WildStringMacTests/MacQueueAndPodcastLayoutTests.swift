import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI
import Testing
import Vision
@testable import WildString

// Shares the serialized HTTP suite because StubURLProtocol has one handler.
extension MacAssistantTests {
    @Test func queuePopupKeepsShellLayoutStableAndRendersFavoritesInBothSchemes() async throws {
        defer { StubURLProtocol.reset() }
        let cover = try solidPngFixture(.init(calibratedRed: 0.25, green: 0.44, blue: 0.62, alpha: 1))
        try configurePodcastAndMusicStubs(cover: cover)

        for scheme in [ColorScheme.light, .dark] {
            let suite = "wildstring.queue-layout-tests.\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }

            let session = try await makeAuthenticatedSession(defaults: defaults)
            defer { teardown(session) }

            session.page = .favorites
            session.playback?.adopt(
                items: [
                    .init(trackID: "song-1", title: "夜晚的港湾", artist: "野弦乐队", album: "深夜频率", streamPath: "unused", durationSeconds: 248),
                    .init(trackID: "song-2", title: "雨声与合成器", artist: "Lin", album: "城市漫步", streamPath: "unused", durationSeconds: 196),
                    .init(trackID: "song-3", title: "长途列车", artist: "北方电台", album: "月台", streamPath: "unused", durationSeconds: 312),
                    .init(trackID: "song-4", title: "微光", artist: "陈屿", album: "回响", streamPath: "unused", durationSeconds: 205),
                ],
                startingAt: 0,
                position: 64,
                mode: "sequential"
            )

            let host = NSHostingView(
                rootView: MacRootView(session: session)
                    .defaultAppStorage(defaults)
                    .preferredColorScheme(scheme)
            )
            let window = NSWindow(
                contentRect: NSRect(x: 100, y: 100, width: 1280, height: 800),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.appearance = NSAppearance(named: scheme == .light ? .aqua : .darkAqua)
            window.isReleasedWhenClosed = false
            window.contentView = host
            window.orderFront(nil)
            defer { window.close() }

            try await Task.sleep(for: .milliseconds(350))
            host.layoutSubtreeIfNeeded()

            let close = try #require(window.standardWindowButton(.closeButton))
            let initialCloseFrame = close.convert(close.bounds, to: nil)
            let initialContentRect = window.contentLayoutRect
            let initialWindowFrame = window.frame

            session.showQueue = true
            try await Task.sleep(for: .milliseconds(300))
            host.layoutSubtreeIfNeeded()

            #expect(close.convert(close.bounds, to: nil) == initialCloseFrame)
            #expect(window.contentLayoutRect == initialContentRect)
            #expect(window.frame == initialWindowFrame)

            let suffix = scheme == .light ? "light" : "dark"
            try saveScreenshot(host: host, name: "mac-shell-favorites-queue-\(suffix)")

            let playback = try #require(session.playback)
            playback.play(items: playback.items, startingAt: 0, sourceCount: 120)
            playback.pause()
            #expect(playback.heartContinuationEnabled)
            try await Task.sleep(for: .milliseconds(150))
            try saveScreenshot(host: host, name: "mac-shell-long-music-queue-\(suffix)")
        }
    }

    @Test func podcastsShellWithTenShowsQueuePopupAndNoDuplicateSpinnerInBothSchemes() async throws {
        defer { StubURLProtocol.reset() }
        let cover = try solidPngFixture(.init(calibratedRed: 0.68, green: 0.36, blue: 0.20, alpha: 1))
        try configurePodcastAndMusicStubs(cover: cover)

        for scheme in [ColorScheme.light, .dark] {
            let suite = "wildstring.podcasts-layout-tests.\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }

            let session = try await makeAuthenticatedSession(defaults: defaults)
            defer { teardown(session) }

            session.page = .podcasts
            session.playback?.adopt(
                items: [
                    .init(
                        trackID: "podcast_ep_ep-41",
                        title: "第 41 期 · 声学与采样率杂谈",
                        artist: "信号与噪声",
                        album: "信号与噪声 · 超长专栏名称测试副标题",
                        streamPath: "api/v1/podcasts/episodes/ep-41/stream?proxy=1&cache=1",
                        resumePositionSeconds: 640,
                        durationSeconds: 2100
                    ),
                    .init(
                        trackID: "podcast_ep_ep-40",
                        title: "第 40 期 · 从磁带到流媒体的动态范围",
                        artist: "信号与噪声",
                        album: "信号与噪声 · 超长专栏名称测试副标题",
                        streamPath: "api/v1/podcasts/episodes/ep-40/stream?proxy=1&cache=1",
                        resumePositionSeconds: 1350,
                        durationSeconds: 2400
                    ),
                ],
                startingAt: 0,
                position: 640,
                mode: "sequential"
            )
            session.showQueue = true

            let host = NSHostingView(
                rootView: MacRootView(session: session)
                    .defaultAppStorage(defaults)
                    .preferredColorScheme(scheme)
            )
            let window = NSWindow(
                contentRect: NSRect(x: 100, y: 100, width: 1280, height: 800),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.appearance = NSAppearance(named: scheme == .light ? .aqua : .darkAqua)
            window.isReleasedWhenClosed = false
            window.contentView = host
            window.orderFront(nil)
            defer { window.close() }

            try await Task.sleep(for: .milliseconds(550))
            host.layoutSubtreeIfNeeded()

            let suffix = scheme == .light ? "light" : "dark"
            let png = try saveScreenshot(host: host, name: "mac-shell-podcasts-queue-\(suffix)")

            let recognition = VNRecognizeTextRequest()
            recognition.recognitionLevel = .accurate
            recognition.recognitionLanguages = ["zh-Hans", "en-US"]
            try VNImageRequestHandler(data: png).perform([recognition])
            let recognized = (recognition.results ?? [])
                .compactMap { $0.topCandidates(1).first?.string }
                .joined(separator: " ")
            #expect(recognized.contains("订阅"))
            #expect(recognized.contains("队列") || recognized.contains("41"))
        }
    }

    @Test func podcastsNarrowViewWithBufferingRowRendersInBothSchemes() async throws {
        defer { StubURLProtocol.reset() }
        let cover = try solidPngFixture(.init(calibratedRed: 0.22, green: 0.48, blue: 0.40, alpha: 1))
        try configurePodcastAndMusicStubs(cover: cover)

        let client = WildstringClient(
            server: try ServerAddress(input: "podcasts-narrow.example.invalid"),
            store: InMemorySessionStore(),
            configuration: StubURLProtocol.configuration()
        )

        for scheme in [ColorScheme.light, .dark] {
            let playback = PlaybackService(
                server: client.server,
                store: InMemoryQueueStore(),
                cookieHeader: { nil },
                resourceConfiguration: StalledStreamProtocol.configuration()
            )
            defer { playback.shutdown() }

            let active = PlaybackService.Item(
                trackID: "podcast_ep_ep-41",
                title: "第 41 期 · 声学与采样率杂谈",
                artist: "信号与噪声",
                album: "信号与噪声 · 超长专栏名称测试副标题",
                streamPath: "api/v1/podcasts/episodes/ep-41/stream?proxy=1&cache=1",
                resumePositionSeconds: 640,
                durationSeconds: 2100
            )
            playback.playPodcastEpisode(active, position: 640)

            let host = NSHostingView(
                rootView: NavigationStack {
                    MacPodcastsView(client: client, playback: playback)
                }
                .preferredColorScheme(scheme)
            )
            let window = NSWindow(
                contentRect: NSRect(x: 120, y: 120, width: 680, height: 720),
                styleMask: [.borderless],
                backing: .buffered,
                defer: false
            )
            window.appearance = NSAppearance(named: scheme == .light ? .aqua : .darkAqua)
            window.isReleasedWhenClosed = false
            window.contentView = host
            window.orderFront(nil)
            defer { window.close() }

            try await Task.sleep(for: .milliseconds(550))
            host.layoutSubtreeIfNeeded()

            #expect(playback.isBuffering)
            let suffix = scheme == .light ? "light" : "dark"
            try saveScreenshot(host: host, name: "mac-podcasts-narrow-\(suffix)")
        }
    }

    private func makeAuthenticatedSession(defaults: UserDefaults) async throws -> MacSession {
        let address = try ServerAddress(input: "layout-fixture.example.invalid")
        let store = InMemorySessionStore()
        try store.saveSession(
            StoredSession(cookies: [
                StoredCookie(
                    name: "session",
                    value: "test-fixture",
                    domain: address.url.host!,
                    path: "/",
                    isSecure: true
                )
            ]),
            origin: address.origin
        )
        MacServers.upsert(
            MacSavedServer(
                address: address.description,
                username: "listener",
                lastUsedAt: .now,
                allowInsecureHTTP: false
            ),
            defaults: defaults
        )
        let session = MacSession(
            store: store,
            queueStore: InMemoryQueueStore(),
            defaults: defaults,
            configuration: StubURLProtocol.configuration()
        )
        await session.restore()
        #expect(session.client != nil)
        return session
    }

    private func teardown(_ session: MacSession) {
        session.sync?.stop()
        session.connection?.stop()
        session.playback?.shutdown()
    }

    private func configurePodcastAndMusicStubs(cover: Data) throws {
        let shows: [[String: Any]] = (1...10).map { index in
            [
                "id": "show-\(index)",
                "title": index == 1
                    ? "信号与噪声 · 超长专栏名称测试副标题"
                    : "第 \(index) 档自托管订阅栏目名称示例",
                "author": "主播 \(index)",
                "description": "每周围绕自托管音频系统、声学测量与开源工具展开深度对话。",
                "total_episodes": 120 + index,
                "unplayed_episodes": index % 3 == 0 ? 0 : index * 2,
                "followed": true,
            ]
        }
        let episodes: [[String: Any]] = [
            [
                "id": "ep-42",
                "podcast_id": "show-1",
                "title": "第 42 期 · 多端进度同步与版本号冲突处理",
                "description": "探讨多设备收听播客时如何用版本号避免后发覆盖。",
                "duration_seconds": 1820,
                "position_seconds": 1820,
                "pub_date": "2026-11-15T08:00:00Z",
                "completed": true,
                "loved": true,
            ],
            [
                "id": "ep-41",
                "podcast_id": "show-1",
                "title": "第 41 期 · 声学与采样率杂谈",
                "description": "比较不同采样率转换器在实时播放中的延时与听感。",
                "duration_seconds": 2100,
                "position_seconds": 640,
                "pub_date": "2026-11-12T08:00:00Z",
                "completed": false,
                "loved": false,
            ],
            [
                "id": "ep-40",
                "podcast_id": "show-1",
                "title": "第 40 期 · 从磁带到流媒体的动态范围",
                "description": "跨设备续播测试用单集，已有远端进度等待接续。",
                "duration_seconds": 2400,
                "position_seconds": 1350,
                "pub_date": "Thu, 06 Nov 2025 08:00:00 +0800",
                "completed": false,
                "loved": false,
            ],
            [
                "id": "ep-39",
                "podcast_id": "show-1",
                "title": "第 39 期 · HTTP Range 分段请求与首帧延迟",
                "description": "分析 CBR MP3 在非精确计时模式下如何减少冗余扫描。",
                "duration_seconds": 1950,
                "position_seconds": 0,
                "pub_date": "Thu, 30 Oct 2025 08:00:00 +0800",
                "completed": false,
                "loved": false,
            ],
        ]
        let showsData = try JSONSerialization.data(withJSONObject: shows)
        let detailsByID: [String: Data] = try Dictionary(uniqueKeysWithValues: shows.enumerated().map { index, show in
            let id = show["id"] as! String
            let payload: [String: Any] = [
                "podcast": show,
                "episodes": index == 0 ? episodes : [],
            ]
            return (id, try JSONSerialization.data(withJSONObject: payload))
        })

        StubURLProtocol.respond { request in
            let url = try #require(request.url)
            let path = url.path
            if path.hasSuffix("/cover") {
                return StubURLProtocol.Stub(
                    statusCode: 200,
                    headers: ["Content-Type": "image/png"],
                    body: cover
                )
            }
            switch path {
            case "/api/v1/auth/status":
                return .json(body: #"{"configured":true,"authenticated":true,"user":{"id":"u1","username":"listener","profile":"listener","version":1,"enabled":true}}"#)
            case "/api/v1/favorites/ids":
                return .json(body: #"{"ids":["song-1","ep-42"]}"#)
            case "/api/v1/podcasts":
                return StubURLProtocol.Stub(statusCode: 200, headers: ["Content-Type": "application/json"], body: showsData)
            case "/api/v1/podcasts/queue":
                return .json(body: #"{"version":1,"device_id":"mac-test","notice":"","items":[]}"#)
            default:
                if path.hasPrefix("/api/v1/podcasts/") {
                    let showID = String(path.dropFirst("/api/v1/podcasts/".count))
                    if let body = detailsByID[showID] ?? detailsByID["show-1"] {
                        return StubURLProtocol.Stub(statusCode: 200, headers: ["Content-Type": "application/json"], body: body)
                    }
                }
                return .json(body: #"{"items":[],"total":0,"limit":100,"offset":0}"#)
            }
        }
    }

    private func solidPngFixture(_ color: NSColor) throws -> Data {
        let image = NSImage(size: NSSize(width: 96, height: 96), flipped: false) { rect in
            color.setFill()
            rect.fill()
            return true
        }
        let tiff = try #require(image.tiffRepresentation)
        return try #require(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
    }

    @discardableResult
    func saveScreenshot(host: NSHostingView<some View>, name: String) throws -> Data {
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        let outputDir = ProcessInfo.processInfo.environment["WILDSTRING_SCREENSHOT_DIR"] ?? "/tmp"
        let url = URL(fileURLWithPath: outputDir).appendingPathComponent("wildstring-\(name).png")
        try png.write(to: url)
        return png
    }
}

private final class StalledStreamProtocol: URLProtocol {
    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StalledStreamProtocol.self]
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 3_600
        return configuration
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {}
    override func stopLoading() {}
}
