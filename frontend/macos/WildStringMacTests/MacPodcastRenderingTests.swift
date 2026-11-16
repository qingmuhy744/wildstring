import AppKit
import CoreNetwork
import CorePlayback
import Network
import SwiftUI
import Testing
@testable import WildString

// Shares the serialized HTTP suite because StubURLProtocol has one handler.
extension MacAssistantTests {
    @Test func podcastCoverFollowsTheQueueEvenWithoutMusicCoverMetadata() async throws {
        func png(_ color: NSColor) throws -> Data {
            let image = NSImage(size: NSSize(width: 32, height: 32), flipped: false) { rect in
                color.setFill(); rect.fill(); return true
            }
            let tiff = try #require(image.tiffRepresentation)
            return try #require(NSBitmapImageRep(data: tiff)?
                .representation(using: .png, properties: [:]))
        }
        let red = try png(.red), blue = try png(.blue)
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        let networkQueue = DispatchQueue(label: "podcast-cover-fixture")
        listener.newConnectionHandler = { connection in
            connection.start(queue: networkQueue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, _ in
                let body = String(data: data ?? Data(), encoding: .utf8)?.contains("/one.png") == true ? red : blue
                var response = Data("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
                response.append(body)
                connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: listener.stateUpdateHandler = nil; continuation.resume()
                case .failed(let error): listener.stateUpdateHandler = nil; continuation.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: networkQueue)
        }
        defer { listener.cancel() }
        let port = try #require(listener.port).rawValue
        StubURLProtocol.respond { request in
            let path = request.url!.path
            if path.contains("/episodes/") {
                return .json(body: "{\"id\":\"\(request.url!.lastPathComponent)\",\"podcast_id\":\"\(request.url!.lastPathComponent)\",\"title\":\"单集\"}")
            }
            return .json(body: "{\"podcast\":{\"id\":\"\(request.url!.lastPathComponent)\",\"title\":\"节目\",\"cover_url\":\"http://127.0.0.1:\(port)/\(request.url!.lastPathComponent).png\"},\"episodes\":[]}")
        }
        let client = WildstringClient(server: try ServerAddress(input: "music.example.com"),
            store: InMemorySessionStore(), configuration: StubURLProtocol.configuration())
        let store = InMemoryQueueStore()
        let items = ["one", "two"].map {
            PlaybackService.Item(trackID: "podcast_ep_\($0)", title: "测试单集", artist: "测试节目",
                streamPath: "api/v1/podcasts/episodes/\($0)/stream")
        }
        let playback = PlaybackService(server: client.server, store: store, cookieHeader: { nil })
        try await store.saveQueue(items, currentIndex: 0)
        await playback.restore()
        let host = NSHostingView(rootView: MacTransportBar(session: MacSession(), client: client, playback: playback))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 94),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        for (index, name) in ["one", "two"].enumerated() {
            if index > 0 {
                try await store.saveQueue(items, currentIndex: index)
                await playback.restore()
            }
            var correctColor = false
            var sampledColor = ""
            for _ in 0..<60 {
                try await Task.sleep(for: .milliseconds(50))
                host.layoutSubtreeIfNeeded()
                let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let color = try #require(bitmap.colorAt(x: Int(46 * CGFloat(bitmap.pixelsWide) / host.bounds.width),
                    y: bitmap.pixelsHigh / 2)?.usingColorSpace(.sRGB))
                sampledColor = "\(color.redComponent), \(color.greenComponent), \(color.blueComponent)"
                // Display color conversion can shift exact RGB values; compare the dominant hue.
                correctColor = index == 0
                    ? color.redComponent - max(color.greenComponent, color.blueComponent) > 0.5
                    : color.blueComponent - max(color.redComponent, color.greenComponent) > 0.5
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    try png.write(to: URL(fileURLWithPath: "/tmp/wildstring-mac-cover-\(name).png"))
                }
                if correctColor { break }
            }
            #expect(correctColor, "Podcast cover should change to \(name); actual RGB: \(sampledColor)")
            #expect(StubURLProtocol.requests.contains { $0.url?.path == "/api/v1/podcasts/episodes/\(name)" })
        }
    }

    @Test func podcastEpisodeRowsKeepProgressAlignedAndHighlightTheWholeRow() throws {
        func episode(id: String, position: Int, completed: Bool = false) throws -> PodcastEpisode {
            let json = #"{"id":""# + id + #"","podcast_id":"show","title":"单集【王局拍案播客】","duration_seconds":3600,"position_seconds":"# + "\(position)" + ",\"completed\":\(completed)}"
            return try JSONDecoder().decode(PodcastEpisode.self, from: Data(json.utf8))
        }
        func render(
            _ episode: PodcastEpisode, current: Bool = false,
            width: CGFloat = 900, scheme: ColorScheme = .light
        ) throws -> NSBitmapImageRep {
            let host = NSHostingView(rootView: MacPodcastEpisodeRow(
                episode: episode, showTitle: "王局拍案播客", current: current, playing: false,
                action: {}, next: {}, append: {}
            ).frame(width: width).background(Color(nsColor: .windowBackgroundColor)).preferredColorScheme(scheme))
            host.frame = NSRect(x: 0, y: 0, width: width, height: 90)
            host.layoutSubtreeIfNeeded()
            let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            return bitmap
        }
        func widestOrangeRow(in bitmap: NSBitmapImageRep) throws -> (count: Int, end: Int) {
            var widestRow = (count: 0, end: -1)
            for y in 0..<bitmap.pixelsHigh {
                var count = 0
                var end = -1
                for x in 0..<bitmap.pixelsWide {
                    let color = try #require(bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB))
                    guard color.redComponent - color.greenComponent > 0.18,
                          color.greenComponent - color.blueComponent > 0.03 else { continue }
                    count += 1
                    end = x
                }
                if count > widestRow.count { widestRow = (count, end) }
            }
            return widestRow
        }

        #expect(cleanPodcastEpisodeTitle("责任全在美方【王局拍案播客】", showTitle: "王志安的播客") == "责任全在美方")

        let completed = try episode(id: "completed", position: 3600, completed: true)
        let partial = try episode(id: "partial", position: 3599)
        let selected = try episode(id: "selected", position: 1800)
        for scheme in [ColorScheme.light, .dark] {
            for width in [CGFloat(500), 900] {
                // Completed episodes grey out and omit the full-width orange progress bar.
                let completedOrange = try widestOrangeRow(in: render(completed, width: width, scheme: scheme))
                #expect(completedOrange.count < bitmapWidthThreshold(width))

                // In-progress episodes show a proportional orange progress bar.
                let partialBitmap = try render(partial, width: width, scheme: scheme)
                let partialOrange = try widestOrangeRow(in: partialBitmap)
                #expect(partialOrange.count > partialBitmap.pixelsWide / 2)

                let halfBitmap = try render(selected, width: width, scheme: scheme)
                let halfOrange = try widestOrangeRow(in: halfBitmap)
                #expect(halfOrange.count > halfBitmap.pixelsWide / 4)
                #expect(partialOrange.end > halfOrange.end)

                let highlighted = try render(selected, current: true, width: width, scheme: scheme)
                let trailing = try #require(highlighted.colorAt(x: highlighted.pixelsWide - 4, y: highlighted.pixelsHigh / 2)?
                    .usingColorSpace(.sRGB))
                #expect(trailing.redComponent - trailing.greenComponent > 0.015)
                #expect(trailing.greenComponent - trailing.blueComponent > 0.005)
            }
        }
    }

    @Test func renderPodcastResumeSurfacesWithIsolatedSession() async throws {
        let suite = "wildstring.resume-visual.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let address = try ServerAddress(input: "resume-visual.example.invalid")
        let sessions = InMemorySessionStore()
        try sessions.saveSession(StoredSession(cookies: [
            StoredCookie(name: "session", value: "fixture", domain: address.url.host!, path: "/", isSecure: true)
        ]), origin: address.origin)
        MacServers.upsert(MacSavedServer(address: address.description, username: "fixture", lastUsedAt: .now,
                                        allowInsecureHTTP: false), defaults: defaults)
        StubURLProtocol.respond { request in
            switch request.url!.path {
            case "/api/v1/auth/status":
                return .json(body: #"{"configured":true,"authenticated":true,"user":{"id":"u1","username":"fixture","profile":"listener","version":1,"enabled":true}}"#)
            case "/api/v1/podcasts/resume-mode": return .json(body: #"{"resume_mode":"auto"}"#)
            case "/api/v1/favorites/ids": return .json(body: #"{"ids":[]}"#)
            default: return .json(body: #"{"items":[],"total":0,"limit":100,"offset":0}"#)
            }
        }
        let session = MacSession(store: sessions, queueStore: InMemoryQueueStore(), defaults: defaults,
                                 configuration: StubURLProtocol.configuration())
        await session.restore()
        let playback = try #require(session.playback)
        let client = try #require(session.client)
        defer { session.sync?.stop(); session.connection?.stop(); playback.shutdown() }
        playback.loadPodcastProgress = { _ in
            PodcastProgressSnapshot(version: 1, positionSeconds: 180, durationSeconds: 3600, completed: false)
        }
        playback.submitPodcastProgress = { _, _ in
            .conflictCurrent(PodcastProgressSnapshot(version: 2, positionSeconds: 900, durationSeconds: 3600,
                                                     completed: false, deviceId: "fixture-other"))
        }
        let episode = PodcastEpisode(id: "fixture", podcastId: "show", title: "合成播客单集", durationSeconds: 3600, positionSeconds: 180)
        let item = PlaybackService.Item(trackID: "podcast_ep_fixture", title: episode.title, artist: "合成节目",
                                        streamPath: "api/v1/podcasts/episodes/fixture/stream", durationSeconds: 3600)
        playback.playPodcastEpisode(item)
        for _ in 0..<30 where playback.podcastProgressMessage == nil {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(playback.podcastProgressMessage != nil)
        func capture<V: View>(_ view: V, name: String, size: NSSize, scheme: ColorScheme) throws {
            let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height)
                .defaultAppStorage(defaults).environment(\.colorScheme, scheme).preferredColorScheme(scheme))
            host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            host.frame = NSRect(origin: .zero, size: size)
            let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
            window.appearance = host.appearance
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let data = try #require(bitmap.representation(using: .png, properties: [:]))
            try data.write(to: URL(fileURLWithPath: "/tmp/wildstring-resume-\(name)-\(scheme == .dark ? "dark" : "light").png"))
        }
        let previousAppearance = NSApp.appearance
        defer { NSApp.appearance = previousAppearance }
        for scheme in [ColorScheme.light, .dark] {
            NSApp.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            try capture(MacSettingsView(session: session), name: "settings", size: NSSize(width: 1100, height: 850), scheme: scheme)
            try capture(MacPodcastPlayer(session: session, client: client, playback: playback), name: "player", size: NSSize(width: 900, height: 850), scheme: scheme)
            try capture(MacPodcastEpisodeRow(episode: episode).background(MacTheme.canvas), name: "row", size: NSSize(width: 900, height: 90), scheme: scheme)
        }
    }

    private func bitmapWidthThreshold(_ width: CGFloat) -> Int {
        Int(width / 6)
    }

}
