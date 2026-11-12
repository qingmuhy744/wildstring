import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI
import Testing
import Vision
import os
@testable import WildString

extension MacAssistantTests {
    @Test func intakeSettingsShowEachLabelOnceAndKeepBothMenus() async throws {
        let playback = PlaybackService(
            server: try ServerAddress(input: "music.example.com"),
            store: InMemoryQueueStore(), cookieHeader: { nil }
        )
        defer { playback.shutdown() }
        for scheme in [ColorScheme.light, .dark] {
            for width in [CGFloat(390), 900] {
                let host = NSHostingView(rootView: PodcastIntakeSettings(playback: playback, podcastID: "fixture")
                    .padding(24)
                    .frame(width: width, height: 180, alignment: .topLeading)
                    .background(MacTheme.canvas)
                    .preferredColorScheme(scheme))
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 180),
                    styleMask: [.borderless], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = host
                window.orderFront(nil)
                defer { window.close() }
                try await Task.sleep(for: .milliseconds(100))
                host.layoutSubtreeIfNeeded()
                let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let appearance = scheme == .light ? "light" : "dark"
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                try png.write(to: URL(fileURLWithPath: "/tmp/wildstring-podcast-settings-\(Int(width))-\(appearance).png"))
                let recognition = VNRecognizeTextRequest()
                recognition.recognitionLevel = .accurate
                recognition.recognitionLanguages = ["zh-Hans", "en-US"]
                try VNImageRequestHandler(data: png).perform([recognition])
                let text = (recognition.results ?? []).compactMap { $0.topCandidates(1).first?.string }
                    .joined(separator: " ").replacingOccurrences(of: " ", with: "")
                for key in ["macPodcasts.newEpisodeIntake", "macPodcasts.autoContinue"] {
                    let label = L10n(key).replacingOccurrences(of: " ", with: "")
                    #expect(text.components(separatedBy: label).count - 1 == 1, "Visible label must occur once: \(text)")
                }
                #expect(text.contains(L10n("macPodcasts.intakeQueueLast").replacingOccurrences(of: " ", with: "")))
                #expect(text.contains(L10n("macPodcasts.continueFollow").replacingOccurrences(of: " ", with: "")))
            }
        }
    }

    @Test func stalledPodcastAudioDoesNotBlockPauseSeekOrSelectingAnotherEpisode() async throws {
        let started = OSAllocatedUnfairLock(initialState: false)
        let finished = OSAllocatedUnfairLock(initialState: false)
        let release = DispatchSemaphore(value: 0)
        StubURLProtocol.respond { _ in
            started.withLock { $0 = true }
            // Bound the fixture even if the regression blocks the main actor.
            _ = release.wait(timeout: .now() + 3)
            finished.withLock { $0 = true }
            throw URLError(.timedOut)
        }
        defer { release.signal() }
        let playback = PlaybackService(
            server: try ServerAddress(input: "music.example.com"),
            store: InMemoryQueueStore(), cookieHeader: { nil },
            resourceConfiguration: StubURLProtocol.configuration()
        )
        defer { playback.shutdown() }
        let episode = PlaybackService.Item(trackID: "podcast_ep_first", title: "Synthetic episode", artist: "Fixture",
            streamPath: "api/v1/podcasts/episodes/first/stream?proxy=1&cache=1")
        playback.playPodcastEpisode(episode, position: 120)
        let deadline = ContinuousClock.now + .seconds(2)
        while !started.withLock({ $0 }), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(started.withLock { $0 })
        #expect(playback.currentItem?.id == episode.id)
        #expect(playback.wantsPlayback)
        playback.pause()
        #expect(!playback.wantsPlayback)
        playback.seek(to: 140)
        #expect(playback.currentTime == 140)
        var next = episode
        next.id = UUID()
        next.trackID = "podcast_ep_second"
        next.streamPath = "api/v1/podcasts/episodes/second/stream?proxy=1&cache=1"
        playback.playPodcastEpisode(next)
        #expect(playback.currentItem?.id == next.id)
        playback.stopAndClear()
        #expect(playback.currentItem == nil)
        #expect(!finished.withLock { $0 }, "Playback controls must return before the stalled request finishes")
    }
}
