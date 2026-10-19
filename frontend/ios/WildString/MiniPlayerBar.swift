import CorePlayback
import Foundation
import SwiftUI

@MainActor
struct MiniPlayerBar: View {
    let playback: PlaybackService

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
                    Spacer()
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
struct MiniPlayerInset: ViewModifier {
    let playback: PlaybackService

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom) {
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
                MiniPlayerBar(playback: playback)
            }
        }
    }
}

extension View {
    func miniPlayer(_ playback: PlaybackService) -> some View {
        modifier(MiniPlayerInset(playback: playback))
    }
}
