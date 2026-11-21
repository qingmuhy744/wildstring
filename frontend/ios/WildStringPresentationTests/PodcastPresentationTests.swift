import CoreNetwork
import CorePlayback
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import WildString

@MainActor
final class PodcastPresentationTests: XCTestCase {
    private var output: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("wildstring-podcast-presentation")
    }

    func testLongMusicQueuePresentation() async throws {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PresentationProtocol.self]
        let server = try ServerAddress(input: "presentation.invalid")
        let client = WildstringClient(server: server, store: InMemorySessionStore(), configuration: configuration)
        let playback = PlaybackService(server: server, store: InMemoryQueueStore(), cookieHeader: { nil })
        defer { playback.shutdown() }
        let items = ["雨声与合成器", "长途列车", "微光"].map {
            PlaybackService.Item(trackID: $0, title: $0, artist: "野弦乐队", album: "月台", streamPath: "unused", durationSeconds: 200)
        }
        playback.play(items: items, startingAt: 0, sourceCount: 120)
        playback.pause()
        XCTAssertTrue(playback.heartContinuationEnabled)
        for width in [CGFloat(390), 1024] {
            for scheme in [ColorScheme.light, .dark] {
                let root = QueueView(client: client, playback: playback)
                    .environment(\.locale, Locale(identifier: "zh-Hans"))
                    .environment(\.colorScheme, scheme)
                let (host, window) = present(root, size: CGSize(width: width, height: 844))
                window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
                try await Task.sleep(for: .milliseconds(200))
                try save(host.view, name: "ios-music-queue-\(Int(width))-\(scheme)")
                window.isHidden = true
            }
        }
    }

    func testPodcastCoverAndMiniPlayerAcrossSizesThemesAndLargeText() async throws {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PresentationProtocol.self]
        let server = try ServerAddress(input: "presentation.invalid")
        let client = WildstringClient(server: server, store: InMemorySessionStore(), configuration: configuration)
        let playback = PlaybackService(server: server, store: InMemoryQueueStore(), cookieHeader: { nil })
        defer { playback.shutdown() }
        playback.loadPodcastProgress = { _ in try await Task.sleep(for: .seconds(60)); return nil }
        let item = PlaybackService.Item(trackID: "podcast_ep_presentation", title: "517 关陇集团是如何炼成的：「八柱国」与西魏北周政权的崛起，以及长标题的布局验证",
            artist: "合成主播", album: "合成声音档案", streamPath: "unused", durationSeconds: 5219)
        let cover = UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256)).image { context in
            UIColor(red: 0.35, green: 0.42, blue: 0.27, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
            UIColor(red: 0.91, green: 0.86, blue: 0.7, alpha: 1).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 48, y: 48, width: 160, height: 160))
        }
        CoverCache.shared.store(cover, for: item.trackID)
        playback.adopt(items: [item], startingAt: 0, position: 11, mode: "sequential")
        for width in [CGFloat(390), 1100] {
            for scheme in [ColorScheme.light, .dark] {
                for large in [false, true] {
                    let root = NowPlayingView(client: client, playback: playback)
                        .environment(FavoritesModel(client: client))
                        .environment(\.horizontalSizeClass, width > 600 ? .regular : .compact)
                        .environment(\.dynamicTypeSize, large ? .xxxLarge : .large)
                        .preferredColorScheme(scheme)
                    let (host, window) = present(root, size: CGSize(width: width, height: width > 600 ? 800 : 844))
                    try await Task.sleep(for: .milliseconds(100))
                    let name = "ios-cover-\(Int(width))-\(scheme)-\(large ? "large" : "normal")"
                    try save(host.view, name: name)
                    XCTAssertGreaterThan(host.view.bounds.height, 700)
                    window.isHidden = true
                }
                let (host, window) = present(MiniPlayerBar(client: client, playback: playback).preferredColorScheme(scheme),
                    size: CGSize(width: width, height: 130))
                try await Task.sleep(for: .milliseconds(50))
                try save(host.view, name: "ios-mini-\(Int(width))-\(scheme)")
                playback.resume()
                try await Task.sleep(for: .milliseconds(350))
                XCTAssertTrue(playback.isBuffering)
                try save(host.view, name: "ios-mini-loading-\(Int(width))-\(scheme)")
                playback.pause()
                window.isHidden = true
                var unavailable = item; unavailable.unavailableReason = "合成音源暂时不可用，请检查连接后重试。"
                playback.play(items: [unavailable], startingAt: 0)
                let (errorHost, errorWindow) = present(NowPlayingView(client: client, playback: playback)
                    .environment(FavoritesModel(client: client)).preferredColorScheme(scheme),
                    size: CGSize(width: width, height: width > 600 ? 800 : 844))
                try await Task.sleep(for: .milliseconds(50))
                try save(errorHost.view, name: "ios-error-\(Int(width))-\(scheme)")
                errorWindow.isHidden = true
                playback.adopt(items: [item], startingAt: 0, position: 11, mode: "sequential")
            }
        }
    }

    func testArticleLoadingEmptyErrorsAndPermissionStates() async throws {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PresentationProtocol.self]
        let server = try ServerAddress(input: "presentation.invalid")
        let client = WildstringClient(server: server, store: InMemorySessionStore(), configuration: configuration)
        let playback = PlaybackService(server: server, store: InMemoryQueueStore(), cookieHeader: { nil })
        defer { playback.shutdown() }
        for scheme in [ColorScheme.light, .dark] {
            for mode in ["200", "empty", "loading", "403", "500"] {
                let item = PlaybackService.Item(trackID: "podcast_ep_article-\(mode)", title: "单集文章与时间码",
                    artist: "合成节目", streamPath: "unused", durationSeconds: 5219)
                playback.adopt(items: [item], startingAt: 0, position: 11, mode: "sequential")
                let root = NowPlayingView(client: client, playback: playback, initiallyShowsLyrics: true)
                    .environment(FavoritesModel(client: client)).preferredColorScheme(scheme)
                let (host, window) = present(root, size: CGSize(width: 390, height: 844))
                try await Task.sleep(for: .milliseconds(500))
                try save(host.view, name: "ios-article-\(mode)-\(scheme)")
                window.isHidden = true
            }
        }
    }

    func testAdaptivePlayerAcrossShortAndWideWindows() async throws {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PresentationProtocol.self]
        let server = try ServerAddress(input: "presentation.invalid")
        let client = WildstringClient(server: server, store: InMemorySessionStore(), configuration: configuration)
        let playback = PlaybackService(server: server, store: InMemoryQueueStore(), cookieHeader: { nil })
        defer { playback.shutdown() }
        let fixtures = [
            ("phone-landscape", CGSize(width: 844, height: 390)),
            ("ipad-narrow", CGSize(width: 510, height: 920)),
            ("ipad-portrait", CGSize(width: 834, height: 1194)),
            ("ipad-landscape", CGSize(width: 1194, height: 834)),
        ]
        for podcast in [false, true] {
            let item = PlaybackService.Item(
                trackID: podcast ? "podcast_ep_article-200" : "music-presentation",
                title: podcast ? "合成播客与长标题：从一段旧磁带说起" : "长途列车",
                artist: podcast ? "合成播客节目" : "野弦乐队",
                streamPath: "unused", durationSeconds: 5219
            )
            playback.adopt(items: [item], startingAt: 0, position: 31, mode: "sequential")
            for (name, size) in fixtures {
                for scheme in [ColorScheme.light, .dark] {
                    let root = NowPlayingView(client: client, playback: playback, initiallyShowsLyrics: podcast)
                        .environment(FavoritesModel(client: client))
                        .preferredColorScheme(scheme)
                    let (host, window) = present(root, size: size)
                    window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
                    try await Task.sleep(for: .milliseconds(350))
                    try save(host.view, name: "ios-adaptive-\(name)-\(podcast ? "article" : "music")-\(scheme)")
                    window.isHidden = true
                }
            }
        }
    }

    func testTransportFramesKeepTheirEdgesAndSettleIncludingReducedMotion() async throws {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        for reduced in [false, true] {
            let state = GlyphState()
            let root = GlyphFixture(state: state, reduced: reduced)
            let (host, window) = present(root, size: CGSize(width: 120, height: 120))
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(50))
            for transition in 0..<3 {
                if transition == 2 { state.buffering = true; try await Task.sleep(for: .milliseconds(300)) }
                state.playing = transition != 1
                state.buffering = false
                var samples: [[String: Any]] = []
                let start = ContinuousClock.now
                var previous: Data?
                for _ in 0..<30 {
                    try await Task.sleep(for: .milliseconds(16))
                    let data = try image(host.view)
                    let elapsed = start.duration(to: .now)
                    let ms = Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
                    samples.append(["time": ms, "changed": previous != nil && previous != data,
                        "edges": try buttonEdges(data)])
                    previous = data
                }
                // "changed" compares with the preceding frame. Both frames must be after the deadline.
                let late = samples.filter { ($0["time"] as! Double) > 350 }.dropFirst()
                XCTAssertFalse(late.contains { $0["changed"] as! Bool }, "The landed glyph must stop changing")
                if reduced { XCTAssertFalse(samples.dropFirst().contains { $0["changed"] as! Bool }) }
                else { XCTAssertGreaterThan(samples.filter { $0["changed"] as! Bool }.count, 3) }
                let firstEdges = samples.first!["edges"] as! [Int]
                XCTAssertTrue(samples.allSatisfy { ($0["edges"] as! [Int]) == firstEdges })
                let name = "ios-glyph-\(reduced)-\(transition)"
                try JSONSerialization.data(withJSONObject: samples).write(to: output.appendingPathComponent("\(name).json"))
                try save(host.view, name: name)
            }
        }
    }

    private func present<V: View>(_ root: V, size: CGSize) -> (UIHostingController<V>, UIWindow) {
        let host = UIHostingController(rootView: root)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        return (host, window)
    }

    private func image(_ view: UIView) throws -> Data {
        view.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { _ in
            view.drawHierarchy(in: view.bounds, afterScreenUpdates: true)
        }
        return try XCTUnwrap(image.pngData())
    }

    private func buttonEdges(_ data: Data) throws -> [Int] {
        let cg = try XCTUnwrap(UIImage(data: data)?.cgImage)
        let width = cg.width, height = cg.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(data: &pixels, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        func orange(_ x: Int, _ y: Int) -> Bool {
            let i = (y * width + x) * 4
            return pixels[i] > 200 && pixels[i + 1] > 70 && pixels[i + 1] < 210 && pixels[i + 2] < 80
        }
        let xs = (0..<width).filter { orange($0, height / 2) }
        let ys = (0..<height).filter { orange(width / 2, $0) }
        return try [XCTUnwrap(xs.first), XCTUnwrap(ys.first), XCTUnwrap(xs.last), XCTUnwrap(ys.last)]
    }

    private func save(_ view: UIView, name: String) throws {
        let data = try image(view)
        try data.write(to: output.appendingPathComponent("\(name).png"))
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}

@Observable @MainActor private final class GlyphState {
    var playing = false
    var buffering = false
}

private struct GlyphFixture: View {
    let state: GlyphState
    let reduced: Bool
    var body: some View {
        PlaybackTransportGlyph(playing: state.playing, buffering: state.buffering, size: 24, motionAllowed: !reduced)
            .frame(width: 64, height: 64).background(.orange, in: Circle())
            .frame(width: 120, height: 120).background(.white)
    }
}

private final class PresentationProtocol: URLProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url!.lastPathComponent != "article-loading" { respond() }
    }
    private func respond() {
        guard !lock.withLock({ cancelled }) else { return }
        let id = request.url!.lastPathComponent
        let status = id == "article-403" ? 403 : (id == "article-500" ? 500 : (request.url!.path.contains("/podcasts/episodes/") ? 200 : 404))
        let description = id == "article-empty" ? "" : "<p>合成单集文章，保留段落与链接。</p><p>01:30 开场，03:00 讨论与回听。</p>"
        let data = try! JSONSerialization.data(withJSONObject: ["id": id, "podcast_id": "show", "title": "合成单集", "description": description, "duration_seconds": 5219])
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { lock.withLock { cancelled = true } }
}
