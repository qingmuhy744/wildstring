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

    var body: some View {
        GeometryReader { geo in
            let isWide = geo.size.width >= 1050
            let hasDrawer = showQueue && !isPodcast
            let drawerWidth: CGFloat = min(380, max(320, geo.size.width * 0.28))
            let shouldShift = hasDrawer && isWide

            ZStack(alignment: .trailing) {
                VStack(spacing: 0) {
                    header
                    if let item = playback.currentItem {
                        stage(item)
                            .frame(maxWidth: shouldShift ? 1440 : 1180)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .padding(.vertical, 16)
                            .padding(.trailing, shouldShift ? (drawerWidth + 24) : 0)
                    } else {
                        ContentUnavailableView("先播放一首喜欢的歌", systemImage: "music.note")
                            .frame(maxHeight: .infinity)
                    }
                    controls
                        .frame(maxWidth: 720)
                        .padding(.trailing, shouldShift ? (drawerWidth + 24) : 0)
                        .padding(.bottom, 24)
                }
                .padding(.horizontal, 36)
                .frame(width: geo.size.width, height: geo.size.height)

                if hasDrawer {
                    if !isWide {
                        Color.black.opacity(0.001)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                showQueue = false
                            }
                    }

                    queueDrawer(width: drawerWidth, height: geo.size.height)
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
            } else {
                showLyrics = true
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
                    HStack(spacing: 4) {
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
                        toggleButton("歌词", symbol: "quote.bubble", isActive: showLyrics) {
                            showLyrics.toggle()
                        }
                        toggleButton("队列", symbol: "list.number", isActive: showQueue) {
                            showQueue.toggle()
                        }
                    }
                    .padding(4).background(ink.opacity(0.045), in: Capsule())
                }
            }
        }
        .padding(.top, 18).padding(.bottom, 4)
    }

    private func toggleButton(_ title: String, symbol: String, isActive: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol).font(.callout)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .foregroundStyle(isActive ? ink : ink.opacity(0.55))
                .background(isActive ? ink.opacity(0.12) : .clear, in: Capsule())
        }
        .buttonStyle(.plain)
        .help(isActive ? "收起\(title)" : "展开\(title)")
    }

    private func stage(_ item: PlaybackService.Item) -> some View {
        GeometryReader { geo in
            let centered = !showLyrics && !showQueue && !isPodcast
            let side = min(centered ? 440 : 340, min(geo.size.width * (centered ? 0.6 : 0.30), max(180, geo.size.height - 140)))
            HStack(alignment: .center, spacing: 48) {
                if centered { Spacer(minLength: 0) }
                VStack(alignment: .leading, spacing: 20) {
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
                            Text(item.title).font(MacTheme.display(24))
                                .foregroundStyle(ink).lineLimit(2)
                            Text([item.artist, item.album ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.callout).foregroundStyle(MacTheme.muted).lineLimit(2)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        if let favorites = session.favorites, !isPodcast {
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
        ZStack(alignment: .topTrailing) {
            ZStack {
                Circle().fill(RadialGradient(colors: [Color(red: 0.19, green: 0.21, blue: 0.17),
                    Color(red: 0.07, green: 0.08, blue: 0.06), Color(red: 0.15, green: 0.17, blue: 0.13)],
                    center: .center, startRadius: 0, endRadius: side / 2))
                ForEach(0..<16, id: \.self) { index in
                    Circle().strokeBorder(Color(red: 0.73, green: 0.76, blue: 0.68).opacity(index.isMultiple(of: 4) ? 0.08 : 0.04), lineWidth: 1)
                        .padding(CGFloat(index) * side * 0.018 + side * 0.025)
                }
                MacCover(client: client, trackID: item.trackID, side: side * 0.44, cornerRadius: side * 0.22)
                    .clipShape(Circle())
                Circle().fill(Color(red: 0.098, green: 0.110, blue: 0.082)).frame(width: 7, height: 7)
            }
            .rotationEffect(.degrees(reduceMotion ? 0 : playback.currentTime * 30))
            .animation(playback.isPlaying && !playback.isBuffering && playback.errorMessage == nil && !reduceMotion
                ? .linear(duration: 1) : nil, value: playback.currentTime)
            Path { path in
                path.move(to: CGPoint(x: side * 0.84, y: side * 0.08))
                path.addLine(to: CGPoint(x: side * 0.79, y: side * 0.31))
                path.addLine(to: CGPoint(x: side * 0.70, y: side * 0.41))
            }
            .stroke(MacTheme.muted, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            .rotationEffect(.degrees(playback.isPlaying && !playback.isBuffering && playback.errorMessage == nil ? 0 : -14),
                anchor: UnitPoint(x: 0.84, y: 0.08))
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: playback.isPlaying && !playback.isBuffering && playback.errorMessage == nil)
            Circle().fill(MacTheme.muted).frame(width: 10, height: 10)
                .position(x: side * 0.84, y: side * 0.08)
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }

    private func queueDrawer(width: CGFloat, height: CGFloat) -> some View {
        let drawerHeight = max(320, height - 180)
        return VStack(spacing: 0) {
            MacQueueView(client: client, playback: playback, showsHeader: true, onClose: {
                showQueue = false
            })
            .padding(18)
        }
        .frame(width: width, height: drawerHeight)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(MacTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(MacTheme.border, lineWidth: 1)
        )
        .padding(.trailing, 28)
    }

    private var controls: some View {
        VStack(spacing: 18) {
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
                }.frame(width: 100, alignment: .leading)
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
                HStack(spacing: 14) {
                    sleepMenu
                    control("captions.bubble", help: session.desktopLyricsVisible ? "关闭桌面歌词" : "打开桌面歌词",
                        active: session.desktopLyricsVisible) {
                        NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
                    }
                }.frame(width: 100, alignment: .trailing)
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
