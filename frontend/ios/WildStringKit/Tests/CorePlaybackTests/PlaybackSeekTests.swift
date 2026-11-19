import AVFoundation
import CoreNetwork
import Foundation
import Testing
@testable import CorePlayback

extension AVPlaybackTests {
@Suite("Playback lyric seeks", .serialized)
@MainActor
struct PlaybackSeekTests {
    @Test func pausedSeeksKeepTheSelectedLineAfterNativeTimeCallbacks() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let audio = directory.appendingPathComponent("silence.wav")
        let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000 * 60))
        buffer.frameLength = buffer.frameCapacity
        buffer.floatChannelData![0].initialize(repeating: 0, count: Int(buffer.frameLength))
        try AVAudioFile(forWriting: audio, settings: format.settings).write(from: buffer)

        let service = PlaybackService(
            server: try ServerAddress(input: "music.example.com"),
            store: InMemoryQueueStore(), cookieHeader: { nil }, offlineLookup: { _ in audio }
        )
        service.player.isMuted = true
        defer { service.shutdown() }
        let item = PlaybackService.Item(trackID: "timing", title: "Synthetic timing", artist: "Test", streamPath: "unused")
        service.adopt(items: [item], startingAt: 0, position: 0, mode: "sequential")
        service.resume()
        service.pause()
        try await waitUntil { service.player.currentItem?.status == .readyToPlay }
        let starts: [Int64] = [0, 28_349, 32_289, 36_359, 40_449, 43_859, 44_758]
        let timeline = LyricTimeline(lyrics: Lyrics(kind: "synced", lines: starts.enumerated().map {
            LyricLine(timeMs: $0.element, text: "Line \($0.offset)")
        }))
        // Seek backwards and forwards across millisecond boundaries while paused.
        // AVPlayer's callback must not move the highlight back to the previous line.
        for index in [2, 3, 1, 6, 4, 2] {
            let target = Double(starts[index]) / 1000
            service.seek(to: target)
            try await waitUntil { abs(service.player.currentTime().seconds - target) < 0.01 }
            // Let any late native time callback arrive; it must not move the line back.
            try await Task.sleep(for: .milliseconds(150))
            #expect(timeline.currentIndex(at: service.player.currentTime().seconds) == index)
            #expect(timeline.currentIndex(at: service.lyricTime) == index)
            #expect(abs(service.currentTime - target) < 0.001)
            #expect(!service.isPlaying)
            #expect(service.player.rate == 0)
        }
        // Rapid requests should settle on the last selected line.
        service.seek(to: 40.449)
        service.seek(to: 28.349)
        service.seek(to: 32.289)
        try await waitUntil { abs(service.player.currentTime().seconds - 32.289) < 0.001 }
        try await Task.sleep(for: .milliseconds(150))
        #expect(timeline.currentIndex(at: service.lyricTime) == 2)
        #expect(abs(service.player.currentTime().seconds - 32.289) < 0.001)
    }

    /// Polls until AVPlayer reaches the state; the deadline only bounds a real failure.
    private func waitUntil(
        timeout: Duration = .seconds(15),
        _ condition: () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        try #require(condition(), "Playback did not reach the expected state")
    }

    @Test func remotePodcastResumeSeeksByByteOffsetWithoutScanningEntireFile() async throws {
        defer { CBRMP3SeekProtocol.reset() }
        let totalBytes: Int64 = 9_600_000 // 25,000 frames * 384 bytes/frame = 600s @ 128 kbps 48 kHz
        CBRMP3SeekProtocol.totalLength = totalBytes

        let service = PlaybackService(
            server: try ServerAddress(input: "podcast-seek.example.invalid"),
            store: InMemoryQueueStore(),
            cookieHeader: { nil },
            resourceConfiguration: CBRMP3SeekProtocol.configuration()
        )
        service.player.isMuted = true
        defer { service.shutdown() }

        let item = PlaybackService.Item(
            trackID: "podcast_ep_long_cbr",
            title: "Long CBR Episode",
            artist: "Host",
            streamPath: "api/v1/podcasts/episodes/long_cbr/stream",
            durationSeconds: 600
        )
        service.playPodcastEpisode(item, position: 510)
        try await waitUntil {
            service.player.currentItem?.status == .readyToPlay
                && service.isPlaying
                && service.player.currentTime().seconds >= 508
        }

        let log = CBRMP3SeekProtocol.snapshotLog()
        let servedBytes = log.reduce(into: Int64(0)) { $0 += $1.bytesServed }
        #expect(servedBytes > 0)
        #expect(servedBytes < totalBytes / 3)
        #expect(!log.contains { $0.rangeHeader == "bytes=0-524287" })
        #expect(abs(service.player.currentTime().seconds - 510) < 5)
    }
}
}

private final class CBRMP3SeekProtocol: URLProtocol {
    struct Entry: Sendable {
        let method: String
        let rangeHeader: String?
        let bytesServed: Int64
    }

    // MPEG-1 Layer III, 128 kbps (index 9), 48000 Hz (index 1), mono:
    // 1152 samples / 48000 Hz = 0.024 s/frame; 144 * 128000 / 48000 = 384 bytes/frame.
    private static let frame: [UInt8] = {
        var bytes = [UInt8](repeating: 0, count: 384)
        bytes[0] = 0xFF
        bytes[1] = 0xFB
        bytes[2] = 0x94
        bytes[3] = 0xC0
        return bytes
    }()

    private static let lock = NSLock()
    nonisolated(unsafe) static var totalLength: Int64 = 9_600_000
    nonisolated(unsafe) private static var log: [Entry] = []

    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CBRMP3SeekProtocol.self]
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        return configuration
    }

    static func reset() {
        lock.withLock {
            totalLength = 9_600_000
            log = []
        }
    }

    static func snapshotLog() -> [Entry] {
        lock.withLock { log }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let length = Self.lock.withLock { Self.totalLength }
        let method = request.httpMethod ?? "GET"
        let rangeHeader = request.value(forHTTPHeaderField: "Range")

        if method == "HEAD" {
            Self.lock.withLock {
                Self.log.append(Entry(method: method, rangeHeader: rangeHeader, bytesServed: 0))
            }
            let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Length": "\(length)",
                    "Content-Type": "audio/mpeg",
                    "Accept-Ranges": "bytes",
                ]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
            return
        }

        let (status, start, end) = Self.parseRange(rangeHeader, totalLength: length)
        let count = max(0, Int(end - start + 1))
        var body = Data(count: count)
        body.withUnsafeMutableBytes { raw in
            guard let ptr = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            let frameCount = Self.frame.count
            for i in 0..<count {
                let globalOffset = Int((start + Int64(i)) % Int64(frameCount))
                ptr[i] = Self.frame[globalOffset]
            }
        }

        Self.lock.withLock {
            Self.log.append(Entry(method: method, rangeHeader: rangeHeader, bytesServed: Int64(count)))
        }
        var headers: [String: String] = [
            "Content-Length": "\(count)",
            "Content-Type": "audio/mpeg",
            "Accept-Ranges": "bytes",
        ]
        if status == 206 {
            headers["Content-Range"] = "bytes \(start)-\(end)/\(length)"
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !body.isEmpty {
            client?.urlProtocol(self, didLoad: body)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func parseRange(_ header: String?, totalLength: Int64) -> (Int, Int64, Int64) {
        guard let header, header.hasPrefix("bytes=") else {
            return (200, 0, max(0, totalLength - 1))
        }
        let spec = String(header.dropFirst("bytes=".count))
        let parts = spec.split(separator: "-", omittingEmptySubsequences: false)
        let start = Int64(parts.first ?? "0") ?? 0
        let end: Int64
        if parts.count > 1, !parts[1].isEmpty, let explicitEnd = Int64(parts[1]) {
            end = min(totalLength - 1, explicitEnd)
        } else {
            end = max(start, totalLength - 1)
        }
        return (206, max(0, start), max(0, end))
    }
}
