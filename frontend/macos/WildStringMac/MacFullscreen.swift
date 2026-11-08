import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI

struct MacFullscreenPlayer: View {
    let session: MacSession
    let client: WildstringClient
    let playback: PlaybackService

    @State private var showLyrics = true
    @State private var showQueue = false
    @State private var showArtwork = false
    @State private var timeline: LyricTimeline?
    @State private var lyricPhase: LyricPhase = .ready
    @State private var lyricAttempt = 0
    @AppStorage("macPlayerStyle") private var playerStyle = "vinyl"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var ink: Color { MacTheme.ink }
    private var showsVinyl: Bool { playerStyle != "cover" }

    private var isPodcast: Bool { playback.currentItem?.trackID.hasPrefix("podcast_ep_") == true }

    init(session: MacSession, client: WildstringClient, playback: PlaybackService,
         initialLyrics: Bool = true, initialQueue: Bool = false) {
        self.session = session
        self.client = client
        self.playback = playback
        _showLyrics = State(initialValue: initialLyrics)
        _showQueue = State(initialValue: initialQueue)
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottomTrailing) {
                VStack(spacing: 0) {
                    header
                    if let item = playback.currentItem {
                        stage(item)
                            .frame(maxWidth: 1440)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .padding(.vertical, 16)
                    } else {
                        ContentUnavailableView("先播放一首喜欢的歌", systemImage: "music.note")
                            .frame(maxHeight: .infinity)
                    }
                    controls
                        .frame(maxWidth: 980)
                        .padding(.bottom, 22)
                }
                .padding(.horizontal, 36)
                .frame(width: geo.size.width, height: geo.size.height)

                if showQueue && !isPodcast {
                    Color.black.opacity(0.001)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            showQueue = false
                        }
                    queuePanel(width: min(360, geo.size.width - 48), height: geo.size.height)
                        .padding(.trailing, 36)
                        .padding(.bottom, 126)
                        .zIndex(10)
                }
            }
            .background(MacTheme.canvas)
            .clipped()
        }
        .foregroundStyle(ink)
        .tint(MacTheme.accent)
        .onExitCommand {
            if showQueue {
                showQueue = false
            } else {
                session.showFullscreen = false
            }
        }
        .task(id: "\(playback.currentItem?.trackID ?? "")-\(lyricAttempt)") { await load() }
        .sheet(isPresented: $showArtwork) {
            if let item = playback.currentItem {
                MacCover(client: client, trackID: item.trackID, side: 500, cornerRadius: 12)
                    .padding(24)
            }
        }
        .onAppear {
            if isPodcast {
                showQueue = false
                showLyrics = false
            }
        }
        .onChange(of: isPodcast) { _, podcast in
            if podcast {
                showQueue = false
                showLyrics = false
            } else {
                showLyrics = true
            }
        }
    }

    private var header: some View {
        ZStack {
            Text(isPodcast ? "正在收听" : "正在播放")
                .font(.callout.weight(.medium)).foregroundStyle(MacTheme.muted)
            HStack {
                Button { session.showFullscreen = false } label: {
                    Image(systemName: "chevron.down").font(.system(size: 16, weight: .semibold))
                        .frame(width: 36, height: 36)
                        .background(ink.opacity(0.06), in: Circle())
                }
                .buttonStyle(.plain).help("收起全屏播放（Esc）").accessibilityLabel("收起全屏播放")
                Spacer()
                if !isPodcast {
                    Menu {
                        Button { playerStyle = "vinyl" } label: {
                            if showsVinyl { Label("唱片", systemImage: "checkmark") } else { Text("唱片") }
                        }
                        Button { playerStyle = "cover" } label: {
                            if !showsVinyl { Label("封面", systemImage: "checkmark") } else { Text("封面") }
                        }
                    } label: {
                        Label(showsVinyl ? "唱片" : "封面", systemImage: "square.stack").font(.callout)
                    }
                    .menuStyle(.borderlessButton).fixedSize().help("播放样式")
                    .padding(4).background(ink.opacity(0.045), in: Capsule())
                }
            }
        }
        .padding(.top, 18).padding(.bottom, 4)
    }

    private func stage(_ item: PlaybackService.Item) -> some View {
        GeometryReader { geo in
            let centered = !showLyrics && !showQueue && !isPodcast
            let side = min(centered ? 500 : 400,
                           min(geo.size.width * (centered ? 0.5 : 0.33), max(200, geo.size.height - 150)))
            HStack(alignment: .center, spacing: 52) {
                if centered { Spacer(minLength: 0) }
                VStack(alignment: .leading, spacing: 22) {
                    Button { showArtwork = true } label: {
                        if showsVinyl && !isPodcast {
                            vinyl(item, side: side)
                        } else {
                            MacCover(client: client, trackID: item.trackID, side: side, cornerRadius: 12)
                        }
                    }
                    .buttonStyle(.plain).help("查看大封面").accessibilityLabel("查看大封面")
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(item.title).font(MacTheme.display(26))
                                .foregroundStyle(ink).lineLimit(2)
                            Text([item.artist, item.album ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.callout).foregroundStyle(MacTheme.muted).lineLimit(2)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        if let favorites = session.favorites {
                            Button { Task { await favorites.toggle(item.trackID) } } label: {
                                Image(systemName: favorites.isFavorite(item.trackID) ? "heart.fill" : "heart")
                                    .font(.title3).frame(width: 28, height: 30)
                                    .foregroundStyle(favorites.isFavorite(item.trackID) ? MacTheme.accentDeep : ink.opacity(0.6))
                            }.buttonStyle(.plain).help(favorites.isFavorite(item.trackID) ? "取消红心" : "红心")
                        }
                    }
                }.frame(width: side)
                if !centered { Group {
                    if isPodcast {
                        MacQueueView(client: client, playback: playback)
                            .padding(20)
                            .background(ink.opacity(0.035), in: RoundedRectangle(cornerRadius: 18))
                    } else if showLyrics {
                        MacLyricScroll(
                            playback: playback, timeline: timeline, empty: "这首歌还没有歌词",
                            prominent: true, phase: lyricPhase, onRetry: { lyricAttempt += 1 }
                        )
                            .id(item.trackID)
                    } else {
                        Color.clear
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity) }
                if centered { Spacer(minLength: 0) }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    private func vinyl(_ item: PlaybackService.Item, side: CGFloat) -> some View {
        let engaged = playback.isPlaying && !playback.isBuffering && playback.errorMessage == nil
        return ZStack(alignment: .topTrailing) {
            ZStack {
                Circle().fill(RadialGradient(colors: [Color(red: 0.19, green: 0.21, blue: 0.17),
                    Color(red: 0.07, green: 0.08, blue: 0.06), Color(red: 0.15, green: 0.17, blue: 0.13)],
                    center: .center, startRadius: 0, endRadius: side / 2))
                ForEach(0..<16, id: \.self) { index in
                    Circle().strokeBorder(Color(red: 0.73, green: 0.76, blue: 0.68).opacity(index.isMultiple(of: 4) ? 0.08 : 0.04), lineWidth: 1)
                        .padding(CGFloat(index) * side * 0.018 + side * 0.025)
                }
                ForEach([0.50, 0.67, 0.84], id: \.self) { ring in
                    Circle().strokeBorder(Color(red: 0.024, green: 0.035, blue: 0.02).opacity(0.22), lineWidth: side * 0.02)
                        .frame(width: side * ring, height: side * ring)
                }
                MacCover(client: client, trackID: item.trackID, side: side * 0.44, cornerRadius: side * 0.22)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color(red: 0.04, green: 0.05, blue: 0.03).opacity(0.65), lineWidth: 2))
                    .overlay(Circle().inset(by: -2.5).stroke(Color(red: 0.86, green: 0.89, blue: 0.80).opacity(0.10), lineWidth: 1))
            }
            .rotationEffect(.degrees(reduceMotion ? 0 : playback.currentTime * 30))
            .animation(engaged && !reduceMotion ? .linear(duration: 1) : nil, value: playback.currentTime)
            // Room-light sheen stays fixed while the disc rotates beneath it.
            vinylSheen(side: side)
            tonearm(side: side, engaged: engaged)
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }

    private func tonearm(side: CGFloat, engaged: Bool) -> some View {
        // Pivot sits outside the platter; at rest the stylus clears the rim (~104% radius), engaged it lands ~66%.
        let pivotX = side * 0.92, pivotY = side * 0.10
        return ZStack {
            ZStack(alignment: .top) {
                Capsule()
                    .fill(LinearGradient(colors: [Color(red: 0.42, green: 0.44, blue: 0.41),
                        Color(red: 0.91, green: 0.90, blue: 0.86), Color(red: 0.61, green: 0.62, blue: 0.58),
                        Color(red: 0.33, green: 0.35, blue: 0.32)], startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(3.5, side * 0.014), height: side * 0.46)
                    .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(Color(red: 0.16, green: 0.18, blue: 0.14))
                    .overlay(alignment: .bottom) {
                        Capsule()
                            .fill(MacTheme.accent)
                            .frame(height: max(2, side * 0.007))
                            .padding(.horizontal, 2)
                            .padding(.bottom, 1)
                    }
                    .frame(width: side * 0.056, height: side * 0.078)
                    .offset(x: -side * 0.008, y: side * 0.445)
            }
            // Fixed arm frame so the rotation anchor (top) sits exactly on the pivot disc.
            .frame(width: side * 0.056, height: side * 0.46, alignment: .top)
            .rotationEffect(.degrees(engaged ? 12 : -10), anchor: .top)
            .position(x: pivotX, y: pivotY + side * 0.23)
            Circle()
                .fill(RadialGradient(colors: [Color(red: 0.64, green: 0.66, blue: 0.62),
                    Color(red: 0.28, green: 0.30, blue: 0.26), Color(red: 0.71, green: 0.72, blue: 0.67)],
                    center: .center, startRadius: 1, endRadius: side * 0.03))
                .frame(width: side * 0.056, height: side * 0.056)
                .position(x: pivotX, y: pivotY)
                .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
        }
    }

    private func queuePanel(width: CGFloat, height: CGFloat) -> some View {
        let panelHeight = max(320, min(520, height - 280))
        return VStack(spacing: 0) {
            MacQueueView(client: client, playback: playback, showsHeader: true, onClose: {
                showQueue = false
            })
            .padding(18)
        }
        .frame(width: width, height: panelHeight)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(MacTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(MacTheme.border, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.18), radius: 22, y: 10)
    }

    private var controls: some View {
        VStack(spacing: 16) {
            HStack(spacing: 12) {
                Text(macPlaybackClock(playback.currentTime)).frame(width: 45, alignment: .trailing)
                PlaybackSlider(playback: playback).tint(MacTheme.accent)
                Text(playback.duration > 0 ? macPlaybackClock(playback.duration) : "—:—")
                    .frame(width: 45, alignment: .leading)
            }
            .font(.caption.monospacedDigit()).foregroundStyle(MacTheme.muted)
            HStack {
                HStack(spacing: 14) {
                    control("shuffle", help: "随机播放", active: playback.isShuffled) { playback.toggleShuffle() }
                    control(playback.repeatMode == .one ? "repeat.1" : "repeat", help: "循环播放",
                        active: playback.repeatMode != .off) { playback.cycleRepeatMode() }
                }
                Spacer()
                HStack(spacing: 28) {
                    control(isPodcast ? "gobackward.15" : "backward.fill", help: isPodcast ? "后退 15 秒" : "上一首") {
                        if isPodcast { playback.seek(to: max(0, playback.currentTime - 15)) } else { playback.previous() }
                    }
                    Button { playback.togglePlayPause() } label: {
                        Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(MacTheme.onAccent).frame(width: 56, height: 56)
                            .background(MacTheme.accent, in: Circle())
                    }.buttonStyle(.plain).help(playback.isPlaying ? "暂停" : "播放")
                        .disabled(playback.currentItem == nil)
                    control(isPodcast ? "goforward.30" : "forward.fill", help: isPodcast ? "前进 30 秒" : "下一首") {
                        if isPodcast { playback.seek(to: playback.currentTime + 30) } else { playback.next() }
                    }
                }
                Spacer()
                HStack(spacing: 12) {
                    if !isPodcast {
                        control("quote.bubble", help: showLyrics ? "收起歌词" : "展开歌词",
                            active: showLyrics) { showLyrics.toggle() }
                        control("list.number", help: showQueue ? "收起队列" : "展开队列",
                            active: showQueue) { showQueue.toggle() }
                    }
                    sleepMenu
                    control("captions.bubble", help: session.desktopLyricsVisible ? "关闭桌面歌词" : "打开桌面歌词",
                        active: session.desktopLyricsVisible) {
                        NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
                    }
                }
            }
            if let message = playback.errorMessage ?? playback.podcastProgressMessage {
                Text(message).font(.caption).foregroundStyle(.orange).lineLimit(1)
            }
        }
    }

    private var sleepMenu: some View {
        Menu {
            Button("15 分钟后暂停") { playback.setSleepTimer(minutes: 15) }
            Button("30 分钟后暂停") { playback.setSleepTimer(minutes: 30) }
            Button("60 分钟后暂停") { playback.setSleepTimer(minutes: 60) }
            Button("这首播完后暂停") { playback.sleepAfterCurrentTrack() }
            Button("取消定时") { playback.cancelSleepTimer() }
        } label: {
            Image(systemName: "moon").font(.system(size: 17))
                .foregroundStyle(playback.sleepTimerEnd != nil || playback.pauseAfterCurrentTrack ? MacTheme.accentDeep : ink.opacity(0.65))
                .frame(width: 28, height: 28)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("定时暂停")
    }

    private func control(_ symbol: String, help: String, active: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 18))
                .foregroundStyle(active ? MacTheme.accentDeep : ink.opacity(0.7))
                .frame(width: 30, height: 30)
        }.buttonStyle(.plain).help(help)
    }

    private func load() async {
        timeline = nil
        guard let item = playback.currentItem, !isPodcast else {
            lyricPhase = .ready
            return
        }
        lyricPhase = .loading
        do {
            let lyrics = try await client.lyrics(trackID: item.trackID)
            guard !Task.isCancelled else { return }
            timeline = LyricTimeline(lyrics: lyrics)
            lyricPhase = .ready
        } catch {
            guard !Task.isCancelled else { return }
            timeline = nil
            lyricPhase = .failed
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
