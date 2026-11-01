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

}
