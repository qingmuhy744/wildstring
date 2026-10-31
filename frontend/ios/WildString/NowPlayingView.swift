import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct NowPlayingView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(FavoritesModel.self) private var favorites
    @AppStorage("playerStyle") private var playerStyleRaw = PlayerStyle.cover.rawValue
    @State private var showLyrics: Bool
    @State private var scrubTime: Double?
    @State private var showingQueue = false
    @State private var showingArtwork = false
    @State private var layoutWidth: CGFloat = 390

    init(client: WildstringClient, playback: PlaybackService, initiallyShowsLyrics: Bool = false) {
        self.client = client
        self.playback = playback
        _showLyrics = State(initialValue: initiallyShowsLyrics)
    }

    private var isRegular: Bool { sizeClass == .regular }

    private var playerStyle: PlayerStyle {
        PlayerStyle(rawValue: playerStyleRaw) ?? .cover
    }

    var body: some View {
        ZStack {
            ArtworkBackdrop(client: client, trackID: playback.currentItem?.trackID)
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
        }
        .tint(.wildAccent)
        .sheet(isPresented: $showingQueue) {
            QueueView(client: client, playback: playback)
        }
        .sheet(isPresented: $showingArtwork) {
            if let item = playback.currentItem {
                ArtworkPreview(client: client, item: item)
                    .presentationDetents([.medium, .large])
            }
        }
        .background {
            GeometryReader { proxy in
                Color.clear.preference(key: PlayerWidthKey.self, value: proxy.size.width)
            }
        }
        .onPreferenceChange(PlayerWidthKey.self) { layoutWidth = $0 }
        .task { openQueueForDemoIfNeeded() }
    }

    private var isPodcast: Bool {
        playback.currentItem?.trackID.hasPrefix("podcast_ep_") == true
    }

    private func openQueueForDemoIfNeeded() {
        #if DEBUG
            if ProcessInfo.processInfo.environment["WILDSTRING_DEMO_OPEN_QUEUE"] == "1" {
                showingQueue = true
            }
        #endif
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
                                ? AnyShapeStyle(Color.wildAccent.opacity(0.22))
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
        VStack(spacing: 16) {
            if let item = playback.currentItem {
                playerArtwork(item)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if !isRegular {
                            withAnimation(.easeInOut(duration: 0.2)) { showLyrics = true }
                        }
                    }
                    .onLongPressGesture(minimumDuration: 0.45) {
                        Haptics.selection()
                        showingArtwork = true
                    }
                    .padding(.top, 8)
                VStack(spacing: 6) {
                    Text(item.title)
                        .font(.title2.bold())
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                    HStack(spacing: 12) {
                        Text(item.artist)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Button {
                            Haptics.selection()
                            Task { await favorites.toggle(item.trackID) }
                        } label: {
                            Image(
                                systemName: favorites.isFavorite(item.trackID)
                                    ? "heart.fill" : "heart"
                            )
                            .foregroundStyle(
                                favorites.isFavorite(item.trackID)
                                    ? Color.wildAccent : Color.secondary
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    if let album = item.album, !album.isEmpty {
                        Text(album)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let label = playback.currentOutputLabel {
                        Text(label)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if let message = playback.podcastProgressMessage {
                        Text(message)
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .multilineTextAlignment(.center)
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
        let width = layoutWidth > 0 ? layoutWidth : 390
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
        VStack(spacing: 12) {
            HStack(spacing: 36) {
                Button {
                    Haptics.selection()
                    playback.toggleShuffle()
                } label: {
                    Image(systemName: "shuffle")
                        .font(.title3)
                        .foregroundStyle(
                            playback.isShuffled ? Color.wildAccent : Color.secondary
                        )
                }
                .buttonStyle(.plain)
                Button {
                    Haptics.tap()
                    if isPodcast {
                        playback.seek(to: playback.currentTime - 15)
                    } else {
                        playback.previous()
                    }
                } label: {
                    Image(systemName: isPodcast ? "gobackward.15" : "backward.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isPodcast ? "后退 15 秒" : "上一首")
                Button {
                    Haptics.tap()
                    playback.togglePlayPause()
                } label: {
                    Image(systemName: playback.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 64))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(playback.isPlaying ? "暂停" : "播放")
                Button {
                    Haptics.tap()
                    if isPodcast {
                        playback.seek(to: playback.currentTime + 30)
                    } else {
                        playback.next()
                    }
                } label: {
                    Image(systemName: isPodcast ? "goforward.30" : "forward.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isPodcast ? "前进 30 秒" : "下一首")
                Button {
                    Haptics.selection()
                    playback.cycleRepeatMode()
                } label: {
                    Image(systemName: playback.repeatMode == .one ? "repeat.1" : "repeat")
                        .font(.title3)
                        .foregroundStyle(
                            playback.repeatMode == .off ? Color.secondary : Color.wildAccent
                        )
                }
                .buttonStyle(.plain)
            }
            HStack(spacing: 44) {
                sleepTimerMenu
                AirPlayRouteButton()
                    .frame(width: 28, height: 28)
                    .accessibilityLabel("隔空播放")
                Button {
                    showingQueue = true
                } label: {
                    Label("播放队列 · \(playback.items.count)", systemImage: "list.bullet")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 12)
        .padding(.bottom, 10)
    }

    private var sleepTimerMenu: some View {
        Menu {
            Button("15 分钟") { playback.setSleepTimer(minutes: 15) }
            Button("30 分钟") { playback.setSleepTimer(minutes: 30) }
            Button("45 分钟") { playback.setSleepTimer(minutes: 45) }
            Button("60 分钟") { playback.setSleepTimer(minutes: 60) }
            Button("播完本曲") { playback.sleepAfterCurrentTrack() }
            if sleepTimerActive {
                Divider()
                Button("关闭定时", role: .destructive) { playback.cancelSleepTimer() }
            }
        } label: {
            Label(sleepTimerLabel, systemImage: "moon.zzz")
                .font(.footnote)
                .foregroundStyle(sleepTimerActive ? Color.wildAccent : Color.secondary)
        }
    }

    private var sleepTimerActive: Bool {
        playback.sleepTimerEnd != nil || playback.pauseAfterCurrentTrack
    }

    private var sleepTimerLabel: String {
        if playback.pauseAfterCurrentTrack { return "播完本曲停止" }
        if let end = playback.sleepTimerEnd {
            let minutes = max(0, Int(ceil(end.timeIntervalSinceNow / 60)))
            return "剩余 \(minutes) 分"
        }
        return "定时"
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
                isPlaying: playback.isPlaying && !reduceMotion
            )
        case .cassette:
            CassetteArtwork(
                client: client,
                trackID: item.trackID,
                width: coverSize,
                isPlaying: playback.isPlaying && !reduceMotion,
                progress: playback.duration > 0 ? playback.currentTime / playback.duration : 0,
                title: item.title
            )
        }
    }
}

private struct PlayerWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        let next = nextValue()
        if next > 0 { value = next }
    }
}

private func timeText(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let total = Int(seconds)
    return String(format: "%d:%02d", total / 60, total % 60)
}

/// Vinyl disc at about one turn every 20 seconds. Pausing keeps the angle.
private struct VinylArtwork: View {
    let client: WildstringClient
    let trackID: String
    let size: CGFloat
    let isPlaying: Bool

    @State private var baseAngle: Double = 0
    @State private var spinStarted: Date?

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !isPlaying)) { context in
            let live =
                isPlaying && spinStarted != nil
                ? context.date.timeIntervalSince(spinStarted ?? context.date) / 20 * 360
                : 0
            let angle = (baseAngle + live).truncatingRemainder(dividingBy: 360)
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
                    .rotationEffect(.degrees(angle))
                CoverImage(
                    client: client,
                    trackID: trackID,
                    size: size * 0.42,
                    circular: true
                )
                Capsule()
                    .fill(Color(white: 0.72))
                    .frame(width: size * 0.03, height: size * 0.22)
                    .offset(x: size * 0.30, y: -size * 0.18)
                    .rotationEffect(.degrees(isPlaying ? 16 : 28), anchor: .top)
            }
            .frame(width: size, height: size)
        }
        .onAppear { spinStarted = isPlaying ? .now : nil }
        .onChange(of: isPlaying) { _, playing in
            anchorSpin(playing: playing, at: .now)
        }
        .onChange(of: trackID) { _, _ in
            baseAngle = 0
            spinStarted = isPlaying ? .now : nil
        }
    }

    private func anchorSpin(playing: Bool, at date: Date) {
        if let spinStarted {
            let delta = date.timeIntervalSince(spinStarted) / 20 * 360
            baseAngle = (baseAngle + delta).truncatingRemainder(dividingBy: 360)
        }
        spinStarted = playing ? date : nil
    }
}

/// Cassette shell with two rotating reels; reels spin only while playing.
private struct CassetteArtwork: View {
    let client: WildstringClient
    let trackID: String
    let width: CGFloat
    let isPlaying: Bool
    let progress: Double
    let title: String

    @State private var baseAngle: Double = 0
    @State private var spinStarted: Date?

    private var height: CGFloat { width * 0.66 }
    private var clampedProgress: Double { min(max(progress, 0), 1) }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !isPlaying)) { context in
            let live =
                isPlaying && spinStarted != nil
                ? context.date.timeIntervalSince(spinStarted ?? context.date) / 6 * 360
                : 0
            let spin = (baseAngle + live).truncatingRemainder(dividingBy: 360)
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
                        reel(rotation: spin, diameter: width * 0.18 * (1 - clampedProgress * 0.45))
                        reel(rotation: -spin, diameter: width * 0.18 * (0.55 + clampedProgress * 0.45))
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, width * 0.06)
            }
            .frame(width: width, height: height)
        }
        .onAppear { spinStarted = isPlaying ? .now : nil }
        .onChange(of: isPlaying) { _, playing in
            if let spinStarted {
                let delta = Date().timeIntervalSince(spinStarted) / 6 * 360
                baseAngle = (baseAngle + delta).truncatingRemainder(dividingBy: 360)
            }
            spinStarted = playing ? .now : nil
        }
    }

    private func reel(rotation: Double, diameter: CGFloat) -> some View {
        ZStack {
            Circle()
                .fill(Color(.tertiarySystemFill))
            Circle()
                .strokeBorder(Color(.systemGray3), lineWidth: 1)
            ForEach(0..<3, id: \.self) { index in
                Capsule()
                    .fill(Color(.systemGray2))
                    .frame(width: max(diameter * 0.08, 1), height: diameter * 0.42)
                    .offset(y: -diameter * 0.16)
                    .rotationEffect(.degrees(Double(index) * 120))
            }
        }
        .frame(width: diameter, height: diameter)
        .rotationEffect(.degrees(rotation))
    }
}

private struct ArtworkPreview: View {
    let client: WildstringClient
    let item: PlaybackService.Item

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                Color(.systemBackground)
                    .ignoresSafeArea()
                VStack(spacing: 18) {
                    GeometryReader { proxy in
                        CoverImage(
                            client: client,
                            trackID: item.hasCover ? item.trackID : nil,
                            size: min(proxy.size.width - 48, 420)
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .aspectRatio(1, contentMode: .fit)
                    .shadow(color: .black.opacity(0.18), radius: 22, y: 10)
                    VStack(spacing: 4) {
                        Text(item.title)
                            .font(.headline)
                            .multilineTextAlignment(.center)
                        Text(item.artist)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    Spacer(minLength: 0)
                }
                .padding(24)
            }
            .navigationTitle("封面")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}
