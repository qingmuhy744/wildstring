import AVFoundation
import CoreNetwork
import Foundation
import Testing
@testable import CorePlayback

@Suite("Playback lifecycle", .serialized)
@MainActor
struct PlaybackLifecycleTests {
    @Test func initialSeekWaitsForReadinessAndHonorsPause() async throws {
        try await withLocalPlayback { service, _, item in
            service.play(items: [item], startingAt: 0, position: 37.123)
            service.pause()
            try await waitUntil {
                service.duration == 60 && abs(service.player.currentTime().seconds - 37.123) < 0.001
            }
            try await Task.sleep(for: .milliseconds(100))
            #expect(service.player.currentItem?.status == .readyToPlay)
            #expect(abs(service.currentTime - 37.123) < 0.001)
            #expect(service.player.rate == 0)
            #expect(!service.isPlaying)
            #expect(!service.isBuffering)
            #expect(service.errorMessage == nil)
        }
    }

    @Test func rapidSeeksKeepLatestPositionWithoutUndoingPause() async throws {
        try await withLocalPlayback { service, store, item in
            service.play(items: [item], startingAt: 0)
            try await waitUntil { service.isPlaying }
            service.seek(to: 40.449)
            service.seek(to: 28.349)
            service.seek(to: 32.289)
            service.pause()
            try await waitUntil { abs(service.player.currentTime().seconds - 32.289) < 0.001 }
            try await Task.sleep(for: .milliseconds(100))
            #expect(abs(service.lyricTime - 32.289) < 0.001)
            #expect(!service.isPlaying)
            #expect(!service.isBuffering)
            #expect(service.player.rate == 0)
            await service.flushPersistence()
            let saved = try #require(try await store.load())
            #expect(abs(saved.position - 32.289) < 0.001)
        }
    }

    @Test func podcastRateSurvivesSeekAndPausedRateChanges() async throws {
        try await withLocalPlayback { service, _, item in
            var episode = item
            episode.trackID = "podcast_ep_synthetic"
            service.setPodcastPlaybackRate(1.5)
            service.play(items: [episode], startingAt: 0, position: 10)
            try await waitUntil { service.isPlaying && service.player.currentTime().seconds >= 10 }
            #expect(service.player.rate == 1.5)
            service.seek(to: 28.349)
            #expect(!service.isPlaying)
            #expect(service.isBuffering)
            #expect(service.player.rate == 0)
            try await waitUntil {
                service.isPlaying && service.player.rate == 1.5
                    && service.player.currentTime().seconds >= 28.349
            }
            #expect(service.player.rate == 1.5)
            service.setPodcastPlaybackRate(2)
            try await waitUntil { service.isPlaying && service.player.rate == 2 }
            #expect(service.player.rate == 2)
            service.pause()
            service.setPodcastPlaybackRate(0.75)
            #expect(service.player.rate == 0)
            service.resume()
            try await waitUntil { service.isPlaying && service.player.rate == 0.75 }
            #expect(service.player.rate == 0.75)
        }
    }

    @Test func failedAudioSessionActivationCanBeRetried() async throws {
        try await withLocalPlayback { service, _, item in
            var attempts = 0
            service.activateAudioSession = {
                attempts += 1
                if attempts == 1 {
                    throw NSError(domain: "PlaybackTest", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "Audio session unavailable"])
                }
            }
            service.play(items: [item], startingAt: 0)
            try await waitUntil { service.player.currentItem?.status == .readyToPlay }
            #expect(service.errorMessage?.contains("Audio session unavailable") == true)
            #expect(service.player.rate == 0)
            #expect(!service.isPlaying)
            #expect(!service.isBuffering)
            #expect(attempts == 1)
            service.resume()
            try await waitUntil { service.isPlaying }
            #expect(service.errorMessage == nil)
            #expect(attempts == 2)
        }
    }

    @Test func clearingDuringSeekDoesNotRestorePlaybackOrSavedQueue() async throws {
        try await withLocalPlayback { service, store, item in
            service.play(items: [item], startingAt: 0)
            try await waitUntil { service.isPlaying }
            service.seek(to: 40.449)
            service.stopAndClear()
            try await Task.sleep(for: .milliseconds(200))
            #expect(service.currentItem == nil)
            #expect(service.player.currentItem == nil)
            #expect(service.currentTime == 0)
            #expect(!service.isPlaying)
            #expect(!service.isBuffering)
            await service.flushPersistence()
            #expect(try await store.load() == nil)
        }
    }

    @Test func replacingItemDuringSeekIgnoresOldCompletion() async throws {
        try await withLocalPlayback { service, _, item in
            service.play(items: [item], startingAt: 0)
            try await waitUntil { service.isPlaying }
            service.seek(to: 40.449)
            let replacement = PlaybackService.Item(trackID: "replacement", title: "Replacement",
                artist: "Test", streamPath: "unused")
            service.play(items: [replacement], startingAt: 0, position: 12.345)
            service.pause()
            try await waitUntil { abs(service.player.currentTime().seconds - 12.345) < 0.001 }
            try await Task.sleep(for: .milliseconds(100))
            #expect(service.currentItem?.id == replacement.id)
            #expect(abs(service.currentTime - 12.345) < 0.001)
            #expect(service.player.rate == 0)
            #expect(!service.isPlaying)
            #expect(service.errorMessage == nil)
        }
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        try #require(condition(), "Playback did not reach the expected state")
    }

    private func withLocalPlayback(
        _ body: (PlaybackService, InMemoryQueueStore, PlaybackService.Item) async throws -> Void
    ) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let audio = directory.appendingPathComponent("silence.wav")
        let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000 * 60))
        buffer.frameLength = buffer.frameCapacity
        buffer.floatChannelData![0].initialize(repeating: 0, count: Int(buffer.frameLength))
        try AVAudioFile(forWriting: audio, settings: format.settings).write(from: buffer)
        let store = InMemoryQueueStore()
        let service = PlaybackService(server: try ServerAddress(input: "music.example.com"),
            store: store, cookieHeader: { nil }, offlineLookup: { _ in audio })
        service.player.isMuted = true
        defer { service.shutdown() }
        let item = PlaybackService.Item(trackID: "synthetic", title: "Synthetic audio",
            artist: "Test", streamPath: "unused")
        try await body(service, store, item)
    }
}
