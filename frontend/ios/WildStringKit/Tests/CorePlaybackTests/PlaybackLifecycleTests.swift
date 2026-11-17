import AVFoundation
import CoreNetwork
import Foundation
import Testing
@testable import CorePlayback

@Suite("Playback lifecycle", .serialized)
@MainActor
struct PlaybackLifecycleTests {
    #if os(iOS)
    @Test func audioSessionNotificationsRecoverLocallyAndRespectExplicitPause() async throws {
        let cloud = ProgressFixture()
        try await withLocalPlayback { service, _, item in
            service.podcastDeviceID = "local"
            service.loadPodcastProgress = { _ in try await cloud.load() }
            service.submitPodcastProgress = { _, write in await cloud.submit(write) }
            var episode = item; episode.trackID = "podcast_ep_synthetic"
            service.playPodcastEpisode(episode)
            try await waitUntil { service.isPlaying }
            await service.waitForPodcastTasks()
            func notify(_ type: AVAudioSession.InterruptionType) {
                NotificationCenter.default.post(name: AVAudioSession.interruptionNotification,
                    object: AVAudioSession.sharedInstance(), userInfo: [
                        AVAudioSessionInterruptionTypeKey: type.rawValue,
                        AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume.rawValue,
                    ])
            }
            notify(.began)
            try await waitUntil { !service.isPlaying }
            await cloud.takeOver(position: 10)
            notify(.ended)
            try await waitUntil { service.isPlaying }
            #expect(service.player.currentTime().seconds >= 30)
            #expect(await cloud.reads == 1)
            notify(.began)
            try await waitUntil { !service.isPlaying }
            service.pause()
            notify(.ended)
            try await Task.sleep(for: .milliseconds(100))
            #expect(service.player.rate == 0)
            #expect(!service.wantsPlayback)
            #expect(await cloud.reads == 1)
        }
    }
    #endif

    @Test func restoringAfterAutomaticContinuationKeepsTheEpisodeActuallyPlaying() async throws {
        try await withLocalPlayback { service, store, item in
            var first = item; first.trackID = "podcast_ep_first"
            service.configurePodcastContinuation(episodes: [
                .init(id: "first", title: "First", chronologicalIndex: 1),
                .init(id: "next", title: "Next", chronologicalIndex: 0),
            ], preference: .init(order: .follow))
            service.playPodcastEpisode(first, position: 30)
            try await waitUntil { service.isPlaying }
            service.handleItemEnded()
            try await waitUntil { service.currentItem?.trackID == "podcast_ep_next" && service.isPlaying }
            await service.flushPersistence()
            let restored = PlaybackService(server: try ServerAddress(input: "music.example.com"), store: store, cookieHeader: { nil })
            defer { restored.shutdown() }
            await restored.restore()
            #expect(restored.currentItem?.trackID == "podcast_ep_next")
            #expect(!restored.wantsPlayback)
        }
    }

    @Test func automaticInterruptionRecoveryKeepsLocalSessionAndHonorsUserPause() async throws {
        let cloud = ProgressFixture()
        try await withLocalPlayback { service, _, item in
            service.podcastDeviceID = "local"
            service.loadPodcastProgress = { _ in try await cloud.load() }
            service.submitPodcastProgress = { _, write in await cloud.submit(write) }
            var episode = item; episode.trackID = "podcast_ep_synthetic"
            service.playPodcastEpisode(episode)
            try await waitUntil { service.isPlaying }
            await service.waitForPodcastTasks()
            service.beginAudioInterruption()
            try await waitUntil { !service.isPlaying }
            await cloud.takeOver(position: 10)
            service.resumeAfterInterruption()
            try await waitUntil { service.isPlaying }
            #expect(service.player.currentTime().seconds >= 30)
            #expect(await cloud.reads == 1)
            service.beginAudioInterruption()
            service.pause()
            service.resumeAfterInterruption()
            #expect(!service.wantsPlayback)
            #expect(service.player.rate == 0)
            service.resume()
            try await waitUntil { service.isPlaying && service.player.currentTime().seconds < 12 }
            #expect(await cloud.reads == 2)
        }
    }

    @Test func blockedPauseUploadDoesNotDelayExplicitResume() async throws {
        let cloud = ProgressFixture()
        do {
            try await withLocalPlayback { service, _, item in
                service.podcastDeviceID = "local"
                service.loadPodcastProgress = { _ in try await cloud.load() }
                service.submitPodcastProgress = { _, write in await cloud.submit(write) }
                var episode = item; episode.trackID = "podcast_ep_synthetic"
                service.playPodcastEpisode(episode)
                try await waitUntil { service.isPlaying }
                await service.waitForPodcastTasks()
                await cloud.blockWrites()
                service.pause()
                try await waitUntil { await cloud.hasBlockedWrite }
                await cloud.takeOver(position: 10)
                service.resume()
                try await waitUntil { service.isPlaying && service.player.currentTime().seconds < 12 }
                #expect(await cloud.hasBlockedWrite)
                await cloud.releaseWrites()
                await service.waitForPodcastTasks()
                #expect(!service.podcastCanUseLocalProgress)
            }
        } catch {
            await cloud.releaseWrites()
            throw error
        }
    }

    @Test func timedOutResumeIgnoresLateReadAndUsesLatestLocalPoint() async throws {
        let cloud = ProgressFixture()
        do {
            try await withLocalPlayback { service, _, item in
                service.podcastDeviceID = "local"
                service.loadPodcastProgress = { _ in try await cloud.load() }
                service.submitPodcastProgress = { _, write in await cloud.submit(write) }
                var episode = item; episode.trackID = "podcast_ep_synthetic"
                service.playPodcastEpisode(episode)
                try await waitUntil { service.isPlaying }
                service.pause()
                await service.waitForPodcastTasks()
                service.podcastReadTimeout = .milliseconds(80)
                await cloud.takeOver(position: 10)
                await cloud.blockReads()
                service.resume()
                try await waitUntil { service.isPlaying }
                #expect(service.player.currentTime().seconds >= 30)
                await cloud.releaseReads()
                await service.waitForPodcastTasks()
                #expect(service.player.currentTime().seconds >= 30)
            }
        } catch {
            await cloud.releaseReads()
            throw error
        }
    }

    @Test func explicitSeekWinsOverRemoteAndCompletedResumeDoesNotReplay() async throws {
        let cloud = ProgressFixture()
        try await withLocalPlayback { service, _, item in
            service.podcastDeviceID = "local"
            service.loadPodcastProgress = { _ in try await cloud.load() }
            service.submitPodcastProgress = { _, write in await cloud.submit(write) }
            var episode = item; episode.trackID = "podcast_ep_synthetic"
            service.playPodcastEpisode(episode)
            try await waitUntil { service.isPlaying }
            service.pause()
            await cloud.takeOver(position: 10)
            service.seek(to: 20)
            try await waitUntil { abs(service.player.currentTime().seconds - 20) < 0.01 }
            service.resume()
            try await waitUntil { service.isPlaying && service.player.currentTime().seconds >= 20 }
            service.pause()
            await service.waitForPodcastTasks()
            await cloud.takeOver(position: 60, completed: true)
            let writes = await cloud.writes.count
            service.resume()
            await service.waitForPodcastTasks()
            #expect(!service.wantsPlayback)
            #expect(service.podcastProgressMessage == KitL10n("kit.playback.podcastAlreadyCompleted"))
            #expect(await cloud.writes.count == writes)
        }
    }

    @Test(arguments: [false, true]) func lostOrUnconfirmedEndingDoesNotStartNextEpisode(lost: Bool) async throws {
        let cloud = ProgressFixture()
        try await withLocalPlayback { service, _, item in
            service.podcastDeviceID = "local"
            service.loadPodcastProgress = { _ in try await cloud.load() }
            service.submitPodcastProgress = { _, write in await cloud.submit(write) }
            service.podcastReadTimeout = .milliseconds(80)
            var episode = item; episode.trackID = "podcast_ep_synthetic"
            var next = item; next.trackID = "podcast_ep_next"
            service.play(items: [episode, next], startingAt: 0, position: 30)
            try await waitUntil { service.isPlaying }
            await service.waitForPodcastTasks()
            if lost { await cloud.takeOver(position: 10) } else { await cloud.setOffline() }
            service.seek(to: 59.8)
            try await waitUntil { !service.wantsPlayback }
            #expect(service.currentItem?.trackID == episode.trackID)
            #expect(await cloud.reads == 1)
        }
    }

    @Test func explicitResumeUsesAnotherDevicesNewerRewind() async throws {
        actor Remote {
            var position = 30
            var reads = 0
            func load() -> PodcastProgressSnapshot {
                reads += 1
                return PodcastProgressSnapshot(version: reads, positionSeconds: position,
                    durationSeconds: 60, completed: false, deviceId: "other-device")
            }
            func rewind() { position = 10 }
        }
        let remote = Remote()
        try await withLocalPlayback { service, _, item in
            service.podcastDeviceID = "local-device"
            service.loadPodcastProgress = { _ in await remote.load() }
            service.submitPodcastProgress = { _, _ in .ok }
            var episode = item
            episode.trackID = "podcast_ep_synthetic"
            service.playPodcastEpisode(episode)
            try await waitUntil { service.isPlaying && service.player.currentTime().seconds >= 30 }
            service.pause()
            await service.waitForPodcastTasks()
            await remote.rewind()
            service.resume()
            try await waitUntil {
                service.isPlaying && (10..<12).contains(service.player.currentTime().seconds)
            }
            #expect(await remote.reads == 2)
        }
    }

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

    /// Polls until AVPlayer reaches the state; the deadline only bounds a real failure, so it is
    /// generous for slow CI runners (a 4 s cap made seeks on busy macOS runners flaky).
    private func waitUntil(
        timeout: Duration = .seconds(15),
        _ condition: () async -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        try #require(await condition(), "Playback did not reach the expected state")
    }

    private actor ProgressFixture {
        var reads = 0
        var writes: [PodcastProgressWrite] = []
        var current = PodcastProgressSnapshot(version: 1, positionSeconds: 30, durationSeconds: 60,
            completed: false, deviceId: "other", sessionId: "other-session", sequence: 1)
        private var offline = false
        private var readsBlocked = false
        private var writesBlocked = false
        private var readers: [(PodcastProgressSnapshot, CheckedContinuation<PodcastProgressSnapshot?, Never>)] = []
        private var writers: [CheckedContinuation<Void, Never>] = []
        var hasBlockedWrite: Bool { !writers.isEmpty }
        func takeOver(position: Int, completed: Bool = false) {
            current = .init(version: current.version + 1, positionSeconds: position, durationSeconds: 60,
                completed: completed, deviceId: "other", sessionId: UUID().uuidString, sequence: 1)
        }
        func setOffline() { offline = true }
        func blockReads() { readsBlocked = true }
        func releaseReads() {
            readsBlocked = false
            let pending = readers; readers = []
            for (snapshot, continuation) in pending { continuation.resume(returning: snapshot) }
        }
        func blockWrites() { writesBlocked = true }
        func releaseWrites() {
            writesBlocked = false
            let pending = writers; writers = []
            for continuation in pending { continuation.resume() }
        }
        func load() async throws -> PodcastProgressSnapshot? {
            reads += 1
            if offline { return nil }
            if readsBlocked { return await withCheckedContinuation { readers.append((current, $0)) } }
            return current
        }
        func submit(_ write: PodcastProgressWrite) async -> PodcastSubmitResult {
            writes.append(write)
            if writesBlocked { await withCheckedContinuation { writers.append($0) } }
            if offline { return .failed }
            let same = current.sessionId == write.sessionId && current.deviceId == write.deviceId
            if !same && current.version != write.baseVersion { return .conflictCurrent(current) }
            if same && write.sequence <= (current.sequence ?? 0) { return current.completed == true ? .completed : .ok }
            let completed = current.completed == true || write.event == "ended"
            current = .init(version: current.version + 1, positionSeconds: write.positionSeconds,
                durationSeconds: write.durationSeconds, completed: completed, deviceId: write.deviceId,
                sessionId: write.sessionId, sequence: write.sequence)
            return completed ? .completed : .ok
        }
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
