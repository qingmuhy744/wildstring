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
    @Environment(\.colorScheme) private var colorScheme
    @Environment(FavoritesModel.self) private var favorites
    @AppStorage("playerStyle") private var playerStyleRaw = PlayerStyle.vinyl.rawValue
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
        PlayerStyle(rawValue: playerStyleRaw) ?? .vinyl
    }

    var body: some View {
        ZStack {
            if playerStyle == .vinyl && !isPodcast {
                Color.playerCanvas
                    .ignoresSafeArea()
            } else {
                ArtworkBackdrop(client: client, trackID: playback.currentItem?.trackID)
            }
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
        .tint(colorScheme == .dark ? .wildAccent : Color(red: 0.737, green: 0.329, blue: 0.22))
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
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n("nowPlaying.close"))
            Spacer()
            Text(L10n("nowPlaying.title"))
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            if isRegular {
                Color.clear.frame(width: 24, height: 1)
            } else {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { showLyrics.toggle() }
                } label: {
                    Text(L10n("nowPlaying.lyricsButton"))
                        .font(.footnote.bold())
                        .frame(width: 44, height: 44)
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
                        .font(.system(.title2, design: .serif, weight: .semibold))
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
                            .foregroundStyle(.secondary)
                    }
                    if let message = playback.errorMessage {
                        Text(message)
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .multilineTextAlignment(.center)
                    }
                }
                progressSection
            } else {
                ContentUnavailableView(L10n("nowPlaying.noPlayback"), systemImage: "music.note")
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
            HStack(spacing: 16) {
                Button {
                    Haptics.selection()
                    playback.toggleShuffle()
                } label: {
                    Image(systemName: "shuffle")
                        .font(.title3)
                        .foregroundStyle(
                            playback.isShuffled ? Color.wildAccent : Color.secondary
                        )
                        .frame(width: 44, height: 44)
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
                    Image(systemName: isPodcast ? "gobackward.15" : "backward.fill")
                        .font(.title2)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isPodcast ? L10n("nowPlaying.rewind15") : L10n("nowPlaying.previousTrack"))
                Button {
                    Haptics.tap()
                    playback.togglePlayPause()
                } label: {
                    Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 24, weight: .semibold))
                        .offset(x: playback.isPlaying ? 0 : 1)
                        .foregroundStyle(colorScheme == .dark ? Color(red: 0.13, green: 0.106, blue: 0.09) : Color(red: 1, green: 0.98, blue: 0.953))
                        .frame(width: 64, height: 64)
                        .background(colorScheme == .dark ? Color.wildAccent : Color(red: 0.737, green: 0.329, blue: 0.22), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(playback.isPlaying ? L10n("nowPlaying.pause") : L10n("nowPlaying.play"))
                Button {
                    Haptics.tap()
                    if isPodcast {
                        playback.seek(to: playback.currentTime + 30)
                    } else {
                        playback.next()
                    }
                } label: {
                    Image(systemName: isPodcast ? "goforward.30" : "forward.fill")
                        .font(.title2)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isPodcast ? L10n("nowPlaying.forward30") : L10n("nowPlaying.nextTrack"))
                Button {
                    Haptics.selection()
                    playback.cycleRepeatMode()
                } label: {
                    Image(systemName: playback.repeatMode == .one ? "repeat.1" : "repeat")
                        .font(.title3)
                        .foregroundStyle(
                            playback.repeatMode == .off ? Color.secondary : Color.wildAccent
                        )
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
            }
            HStack(spacing: 44) {
                sleepTimerMenu
                AirPlayRouteButton()
                    .frame(width: 28, height: 28)
                    .accessibilityLabel(L10n("nowPlaying.airPlay"))
                Button {
                    showingQueue = true
                } label: {
                    let count = (isPodcast && playback.podcastCloud != nil)
                        ? (playback.podcastCloud?.items.count ?? playback.items.count)
                        : playback.items.count
                    Label(L10n("nowPlaying.queueCount", count), systemImage: "list.bullet")
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
            Button(L10n("nowPlaying.sleepTimer15")) { playback.setSleepTimer(minutes: 15) }
            Button(L10n("nowPlaying.sleepTimer30")) { playback.setSleepTimer(minutes: 30) }
            Button(L10n("nowPlaying.sleepTimer45")) { playback.setSleepTimer(minutes: 45) }
            Button(L10n("nowPlaying.sleepTimer60")) { playback.setSleepTimer(minutes: 60) }
            Button(L10n("nowPlaying.sleepAfterCurrent")) { playback.sleepAfterCurrentTrack() }
            if sleepTimerActive {
                Divider()
                Button(L10n("nowPlaying.cancelSleepTimer"), role: .destructive) { playback.cancelSleepTimer() }
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
        if playback.pauseAfterCurrentTrack { return L10n("nowPlaying.stopAfterCurrent") }
        if let end = playback.sleepTimerEnd {
            let minutes = max(0, Int(ceil(end.timeIntervalSinceNow / 60)))
            return L10n("nowPlaying.sleepTimerRemaining", minutes)
        }
        return L10n("nowPlaying.sleepTimer")
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
                isPlaying: playback.isPlaying && !playback.isBuffering && playback.errorMessage == nil,
                reduceMotion: reduceMotion
            )
        case .cassette:
            CassetteArtwork(
                client: client,
                trackID: item.trackID,
                width: coverSize,
                isPlaying: playback.isPlaying && !playback.isBuffering && playback.errorMessage == nil && !reduceMotion,
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
    let reduceMotion: Bool

    @State private var baseAngle: Double = 0
    @State private var spinStarted: Date?

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !isPlaying || reduceMotion)) { context in
            let live =
                isPlaying && !reduceMotion && spinStarted != nil
                ? context.date.timeIntervalSince(spinStarted ?? context.date) / 20 * 360
                : 0
            let angle = (baseAngle + live).truncatingRemainder(dividingBy: 360)
            ZStack {
                ZStack {
                    Circle().fill(RadialGradient(colors: [Color(red: 0.18, green: 0.165, blue: 0.145), Color(red: 0.059, green: 0.051, blue: 0.043), Color(red: 0.133, green: 0.118, blue: 0.102)], center: .center, startRadius: 0, endRadius: size / 2))
                    ForEach(0..<32, id: \.self) { index in
                        Circle()
                            .stroke(Color(red: 0.784, green: 0.749, blue: 0.698).opacity(0.08), lineWidth: 0.65)
                            .frame(width: size * (0.46 + CGFloat(index) * 0.016))
                    }
                    ForEach([0.50, 0.67, 0.84], id: \.self) { ring in
                        Circle()
                            .stroke(Color(red: 0.024, green: 0.035, blue: 0.02).opacity(0.22), lineWidth: size * 0.02)
                            .frame(width: size * ring)
                    }
                    CoverImage(client: client, trackID: trackID, size: size * 0.44, circular: true)
                        .overlay(Circle().stroke(Color(red: 0.04, green: 0.05, blue: 0.03).opacity(0.65), lineWidth: 2))
                        .overlay(Circle().inset(by: -2.5).stroke(Color(red: 0.86, green: 0.89, blue: 0.80).opacity(0.10), lineWidth: 1))
                    Circle().fill(Color(red: 0.102, green: 0.09, blue: 0.078)).frame(width: 8, height: 8)
                }
                .rotationEffect(.degrees(angle))
                vinylSheen(side: size)
                Path { path in
                    path.move(to: CGPoint(x: size * 0.87, y: size * 0.05))
                    path.addLine(to: CGPoint(x: size * (isPlaying ? 0.81 : 0.90), y: size * 0.31))
                    path.addLine(to: CGPoint(x: size * (isPlaying ? 0.70 : 0.84), y: size * 0.42))
                }
                .stroke(Color(white: 0.65), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                Circle()
                    .fill(Color(white: 0.65))
                    .frame(width: 11, height: 11)
                    .position(x: size * 0.87, y: size * 0.05)
            }
            .frame(width: size, height: size)
        }
        .onAppear { spinStarted = isPlaying && !reduceMotion ? .now : nil }
        .onChange(of: isPlaying) { _, playing in
            anchorSpin(playing: playing && !reduceMotion, at: .now)
        }
        .onChange(of: reduceMotion) { _, reduced in
            anchorSpin(playing: isPlaying && !reduced, at: .now)
        }
        .onChange(of: trackID) { _, _ in
            baseAngle = 0
            spinStarted = isPlaying && !reduceMotion ? .now : nil
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
                            trackID: item.coverTrackID,
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
            .navigationTitle(L10n("nowPlaying.artwork"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L10n("nowPlaying.done")) { dismiss() }
                }
            }
        }
    }
}

/// Fixed room-light wedges for the vinyl (DESIGN.md §6.7): point-symmetric, soft, never rotated with the platter.
/// AngularGradient starts at 3 o'clock and runs clockwise: lower right 45°, upper left 225°.
func vinylSheen(side: CGFloat) -> some View {
    let warm = Color(red: 1, green: 0.957, blue: 0.878)
    let profile: [(Double, Double)] = [(-23, 0), (-17, 0.02), (-9, 0.06), (0, 0.12), (9, 0.06), (17, 0.02), (23, 0)]
    var stops: [Gradient.Stop] = [.init(color: warm.opacity(0), location: 0)]
    for centre in [45.0, 225.0] {
        for (offset, alpha) in profile {
            stops.append(.init(color: warm.opacity(alpha), location: (centre + offset) / 360))
        }
    }
    stops.append(.init(color: warm.opacity(0), location: 1))
    return Circle()
        .fill(AngularGradient(gradient: Gradient(stops: stops), center: .center))
        .mask(
            Circle().fill(RadialGradient(stops: [
                .init(color: .clear, location: 0.46), .init(color: .black, location: 0.55),
                .init(color: .black, location: 0.85), .init(color: .clear, location: 0.99),
            ], center: .center, startRadius: 0, endRadius: side / 2))
        )
        .allowsHitTesting(false)
}
