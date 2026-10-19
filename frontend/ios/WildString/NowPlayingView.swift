import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct NowPlayingView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(FavoritesModel.self) private var favorites
    @State private var showLyrics: Bool
    @State private var scrubTime: Double?

    init(client: WildstringClient, playback: PlaybackService, initiallyShowsLyrics: Bool = false) {
        self.client = client
        self.playback = playback
        _showLyrics = State(initialValue: initiallyShowsLyrics)
    }

    private var isRegular: Bool { sizeClass == .regular }

    var body: some View {
        VStack(spacing: 0) {
            header
            if isRegular {
                HStack(alignment: .top, spacing: 28) {
                    playerColumn
                        .frame(maxWidth: 400)
                    LyricsPane(client: client, playback: playback)
                        .frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 28)
                Spacer(minLength: 0)
            } else {
                if showLyrics {
                    LyricsPane(client: client, playback: playback)
                } else {
                    playerColumn
                }
                Spacer(minLength: 0)
            }
            controls
        }
        .background(Color(.systemBackground))
    }

    private var header: some View {
        HStack {
            Button {
                dismiss()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.body.bold())
            }
            .buttonStyle(.plain)
            Spacer()
            Text("正在播放")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            if isRegular {
                Color.clear.frame(width: 24, height: 1)
            } else {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { showLyrics.toggle() }
                } label: {
                    Text("词")
                        .font(.footnote.bold())
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(
                            showLyrics
                                ? AnyShapeStyle(Color.accentColor.opacity(0.18))
                                : AnyShapeStyle(Color.clear),
                            in: Capsule()
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
    }

    private var playerColumn: some View {
        VStack(spacing: 18) {
            if let item = playback.currentItem {
                CoverImage(client: client, trackID: item.trackID, size: coverSize)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if !isRegular {
                            withAnimation(.easeInOut(duration: 0.2)) { showLyrics = true }
                        }
                    }
                    .padding(.top, 8)
                VStack(spacing: 6) {
                    Text(item.title)
                        .font(.title3.bold())
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                    HStack(spacing: 12) {
                        Text(item.artist)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Button {
                            Task { await favorites.toggle(item.trackID) }
                        } label: {
                            Image(
                                systemName: favorites.isFavorite(item.trackID)
                                    ? "heart.fill" : "heart"
                            )
                            .foregroundStyle(
                                favorites.isFavorite(item.trackID) ? Color.pink : Color.secondary
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                progressSection
            } else {
                ContentUnavailableView("暂无播放", systemImage: "music.note")
            }
        }
        .padding(.horizontal, 24)
    }

    private var coverSize: CGFloat {
        let width = UIScreen.main.bounds.width
        return min(width * 0.72, isRegular ? 320 : 340)
    }

    private var progressSection: some View {
        VStack(spacing: 4) {
            Slider(
                value: Binding(
                    get: { scrubTime ?? playback.currentTime },
                    set: { scrubTime = $0 }
                ),
                in: 0...max(playback.duration, 1)
            ) { editing in
                if !editing, let time = scrubTime {
                    playback.seek(to: time)
                    scrubTime = nil
                }
            }
            HStack {
                Text(timeText(scrubTime ?? playback.currentTime))
                Spacer()
                Text(timeText(playback.duration))
            }
            .font(.caption2)
            .monospacedDigit()
            .foregroundStyle(.secondary)
        }
    }

    private var controls: some View {
        HStack(spacing: 48) {
            Button {
                playback.previous()
            } label: {
                Image(systemName: "backward.fill").font(.title2)
            }
            .buttonStyle(.plain)
            Button {
                playback.togglePlayPause()
            } label: {
                Image(systemName: playback.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 64))
            }
            .buttonStyle(.plain)
            Button {
                playback.next()
            } label: {
                Image(systemName: "forward.fill").font(.title2)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 18)
    }
}

private func timeText(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let total = Int(seconds)
    return String(format: "%d:%02d", total / 60, total % 60)
}
