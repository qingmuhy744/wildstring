import AVFoundation
import CoreNetwork
import Foundation
import Testing
@testable import CorePlayback

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
}
