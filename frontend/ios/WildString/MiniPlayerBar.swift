import CoreNetwork
import CorePlayback
import Foundation
import SwiftUI

@MainActor
struct MiniPlayerBar: View {
    let playback: PlaybackService
    var onExpand: (() -> Void)?

    var body: some View {
        if let item = playback.currentItem {
            VStack(spacing: 0) {
                Divider()
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.subheadline)
                            .lineLimit(1)
                        Text(item.artist)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture { onExpand?() }
                    if playback.duration > 0 {
                        Text(
                            "\(timeText(playback.currentTime)) / \(timeText(playback.duration))"
                        )
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    }
                    if playback.isBuffering {
                        ProgressView()
                    }
                    Button {
                        playback.togglePlayPause()
                    } label: {
                        Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                            .font(.title2)
                    }
                    .buttonStyle(.plain)
                    Button {
                        playback.next()
                    } label: {
                        Image(systemName: "forward.fill")
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.bar)
            }
        }
    }

    private func timeText(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// Adds the mini player (and playback errors) above the tab bar of a screen.
/// Tapping the bar expands the full player; in DEBUG a demo hook can open it
/// automatically for simulator verification runs.
struct MiniPlayerInset: ViewModifier {
    let playback: PlaybackService
    let client: WildstringClient

    @State private var showPlayer = false

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 0) {
                    if let message = playback.errorMessage {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                            Text(message)
                                .lineLimit(2)
                            Spacer(minLength: 0)
                        }
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity)
                        .background(.bar)
                    }
                    MiniPlayerBar(playback: playback, onExpand: { showPlayer = true })
                }
            }
            .fullScreenCover(isPresented: $showPlayer) {
                NowPlayingView(
                    client: client,
                    playback: playback,
                    initiallyShowsLyrics: Self.demoShowsLyrics
                )
            }
            .task { await openPlayerForDemoIfNeeded() }
    }

    private func openPlayerForDemoIfNeeded() async {
        #if DEBUG
            guard ProcessInfo.processInfo.environment["WILDSTRING_DEMO_OPEN_PLAYER"] == "1"
            else { return }
            for _ in 0..<30 {
                if playback.currentItem != nil { break }
                try? await Task.sleep(for: .milliseconds(500))
            }
            if playback.currentItem != nil {
                showPlayer = true
            }
        #endif
    }

    private static var demoShowsLyrics: Bool {
        #if DEBUG
            ProcessInfo.processInfo.environment["WILDSTRING_DEMO_OPEN_LYRICS"] == "1"
        #else
            false
        #endif
    }
}

extension View {
    func miniPlayer(_ playback: PlaybackService, client: WildstringClient) -> some View {
        modifier(MiniPlayerInset(playback: playback, client: client))
    }
}
