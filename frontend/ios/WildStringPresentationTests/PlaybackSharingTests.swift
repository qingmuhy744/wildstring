import CoreNetwork
import CorePlayback
import Foundation
import XCTest
@testable import WildString

@MainActor
final class PlaybackSharingTests: XCTestCase {
    func testRestoresMusicDurationBeforePlayback() async throws {
        let track = try JSONDecoder().decode(Track.self, from: Data(
            #"{"id":"track","title":"Track","artists":["Artist"],"duration_ms":12500,"has_cover":false}"#.utf8
        ))
        let store = InMemoryQueueStore()
        try await store.saveQueue([track.playbackItem], currentIndex: 0)
        try await store.saveProgress(QueueProgress(index: 0, position: 7))
        let server = try ServerAddress(input: "handoff.example.invalid")
        let playback = PlaybackService(server: server, store: store, cookieHeader: { nil })
        defer { playback.shutdown() }
        await playback.restore()
        XCTAssertEqual(playback.currentTime, 7)
        XCTAssertEqual(playback.duration, 12.5)
        XCTAssertFalse(playback.wantsPlayback)
    }

    func testLongSharedQueueOffersAndAdoptsSelectedWindow() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "wildstring.handoff.\(UUID().uuidString)"))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HandoffProtocol.self]
        let server = try ServerAddress(input: "handoff.example.invalid")
        let client = WildstringClient(server: server, store: InMemorySessionStore(), configuration: configuration)
        let playback = PlaybackService(server: server, store: InMemoryQueueStore(), cookieHeader: { nil })
        defer { playback.shutdown() }
        let sharing = PlaybackSharingModel(client: client, playback: playback, defaults: defaults)
        await sharing.poll()
        let offer = try XCTUnwrap(sharing.handoff)
        XCTAssertEqual(offer.index, 0)
        XCTAssertEqual(offer.tracks.count, 100)
        XCTAssertEqual(offer.tracks[offer.index].id, "t300")
        await sharing.accept(offer)
        XCTAssertEqual(playback.currentItem?.trackID, "t300")
        XCTAssertEqual(playback.currentTime, 42.5)
        XCTAssertEqual(playback.items.count, 100)
        XCTAssertFalse(playback.wantsPlayback)
    }
}

private final class HandoffProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let body: Data
        if url.path == "/api/v1/playback/state" {
            body = try! JSONSerialization.data(withJSONObject: [
                "version": 5, "device_id": "remote", "track_ids": (0..<450).map { "t\($0)" },
                "index": 300, "position_ms": 42500, "mode": "sequential", "playback_state": "paused",
                "paused_at": "2026-11-19T00:00:00Z", "handoff_eligible": true
            ])
        } else {
            let id = url.lastPathComponent
            body = Data(#"{"id":"\#(id)","title":"\#(id)","artists":[],"album":null,"duration_ms":1000,"has_cover":false}"#.utf8)
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
