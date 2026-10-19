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
    @AppStorage("playerStyle") private var playerStyleRaw = PlayerStyle.cover.rawValue
    @State private var showLyrics: Bool
    @State private var scrubTime: Double?

    private var playerStyle: PlayerStyle {
        PlayerStyle(rawValue: playerStyleRaw) ?? .cover
    }

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
                playerArtwork(item)
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
                Haptics.tap()
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

    @ViewBuilder
    private func playerArtwork(_ item: PlaybackService.Item) -> some View {
        switch playerStyle {
        case .cover:
            CoverImage(client: client, trackID: item.trackID, size: coverSize)
        case .vinyl:
            VinylArtwork(
                client: client,
                trackID: item.trackID,
                size: coverSize,
                isPlaying: playback.isPlaying
            )
        case .cassette:
            CassetteArtwork(
                client: client,
                trackID: item.trackID,
                width: coverSize,
                isPlaying: playback.isPlaying,
                title: item.title
            )
        }
    }
}

private func timeText(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let total = Int(seconds)
    return String(format: "%d:%02d", total / 60, total % 60)
}

/// Rotating vinyl disc with the cover in the center; spins only while playing.
private struct VinylArtwork: View {
    let client: WildstringClient
    let trackID: String
    let size: CGFloat
    let isPlaying: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !isPlaying)) { context in
            let seconds = context.date.timeIntervalSinceReferenceDate
            let angle = isPlaying ? seconds.truncatingRemainder(dividingBy: 12) / 12 * 360 : 0
            ZStack {
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [Color(white: 0.20), Color(white: 0.06)],
                            center: .center,
                            startRadius: 0,
                            endRadius: size / 2
                        )
                    )
                    .overlay(Circle().stroke(Color(white: 0.28), lineWidth: 1))
                CoverImage(
                    client: client,
                    trackID: trackID,
                    size: size * 0.42,
                    circular: true
                )
            }
            .frame(width: size, height: size)
            .rotationEffect(.degrees(angle))
        }
    }
}

/// Cassette shell with two rotating reels; reels spin only while playing.
private struct CassetteArtwork: View {
    let client: WildstringClient
    let trackID: String
    let width: CGFloat
    let isPlaying: Bool
    let title: String

    private var height: CGFloat { width * 0.66 }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !isPlaying)) { context in
            let seconds = context.date.timeIntervalSinceReferenceDate
            let spin = isPlaying ? seconds.truncatingRemainder(dividingBy: 6) / 6 * 360 : 0
            ZStack {
                RoundedRectangle(cornerRadius: 14)
                    .fill(Color(.secondarySystemBackground))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(Color(.separator), lineWidth: 1)
                    )
                VStack(spacing: width * 0.04) {
                    Text(title)
                        .font(.caption.bold())
                        .lineLimit(1)
                        .padding(.horizontal, width * 0.08)
                    HStack(spacing: width * 0.2) {
                        reel(rotation: spin)
                        reel(rotation: -spin)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, width * 0.06)
            }
            .frame(width: width, height: height)
        }
    }

    private func reel(rotation: Double) -> some View {
        ZStack {
            Circle()
                .fill(Color(.tertiarySystemFill))
            Circle()
                .strokeBorder(Color(.systemGray3), lineWidth: 1)
            ForEach(0..<3, id: \.self) { index in
                Capsule()
                    .fill(Color(.systemGray2))
                    .frame(width: width * 0.018, height: width * 0.08)
                    .offset(y: -width * 0.03)
                    .rotationEffect(.degrees(Double(index) * 120))
            }
        }
        .frame(width: width * 0.16, height: width * 0.16)
        .rotationEffect(.degrees(rotation))
    }
}
