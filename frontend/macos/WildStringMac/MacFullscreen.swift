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
    @State private var timeline: LyricTimeline?
    @State private var palette = MacArtworkPalette.neutral
    @Environment(\.colorScheme) private var colorScheme

    private var dark: Bool { colorScheme == .dark }
    private var ink: Color { dark ? .white : Color(red: 0.13, green: 0.12, blue: 0.11) }

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
                        .padding(.bottom, 24)
                }
                .padding(.horizontal, 36)
                .frame(width: geo.size.width, height: geo.size.height)

                if hasDrawer {
                    if !isWide {
                        Color.black.opacity(0.001)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.82)) {
                                    showQueue = false
                                }
                            }
                    }

                    queueDrawer(width: drawerWidth, height: geo.size.height)
                        .transition(.asymmetric(
                            insertion: .move(edge: .trailing).combined(with: .opacity),
                            removal: .move(edge: .trailing).combined(with: .opacity)
                        ))
                        .zIndex(10)
                }
            }
            .animation(.spring(response: 0.38, dampingFraction: 0.82), value: showQueue)
            .animation(.spring(response: 0.38, dampingFraction: 0.82), value: showLyrics)
            .background {
                ZStack {
                    LinearGradient(colors: palette.colors(dark: dark), startPoint: .topLeading, endPoint: .bottomTrailing)
                    RadialGradient(colors: [.white.opacity(dark ? 0.035 : 0.35), .clear],
                        center: .topTrailing, startRadius: 0, endRadius: max(geo.size.width, geo.size.height) * 0.85)
                    LinearGradient(colors: [.clear, dark ? .black.opacity(0.30) : .white.opacity(0.25)],
                        startPoint: .center, endPoint: .bottom)
                }
                .animation(.easeInOut(duration: 1.1), value: palette)
                .animation(.easeInOut(duration: 0.4), value: dark)
                .frame(width: geo.size.width, height: geo.size.height)
                .clipped()
            }
            .clipped()
        }
        .foregroundStyle(ink)
        .tint(MacTheme.accent)
        .onExitCommand {
            if showQueue {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.82)) {
                    showQueue = false
                }
            } else {
                session.showFullscreen = false
            }
        }
        .task(id: playback.currentItem?.trackID) { await load() }
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
                .font(.callout.weight(.medium)).foregroundStyle(ink.opacity(0.65))
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
                        toggleButton("歌词", symbol: "quote.bubble", isActive: showLyrics) {
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.82)) {
                                showLyrics.toggle()
                            }
                        }
                        toggleButton("队列", symbol: "list.number", isActive: showQueue) {
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.82)) {
                                showQueue.toggle()
                            }
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
            let side = min(340, min(geo.size.width * 0.30, max(180, geo.size.height - 140)))
            HStack(alignment: .center, spacing: 48) {
                VStack(alignment: .leading, spacing: 20) {
                    MacCover(client: client, trackID: item.trackID,
                        side: side, cornerRadius: 12)
                        .shadow(color: .black.opacity(dark ? 0.45 : 0.16), radius: 28, y: 16)
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(item.title).font(.system(size: 22, weight: .semibold))
                                .foregroundStyle(ink).lineLimit(2)
                            Text([item.artist, item.album ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.callout).foregroundStyle(ink.opacity(0.6)).lineLimit(2)
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
                Group {
                    if isPodcast {
                        MacQueueView(client: client, playback: playback)
                            .padding(20)
                            .background(ink.opacity(0.035), in: RoundedRectangle(cornerRadius: 18))
                    } else if showLyrics {
                        MacLyricScroll(playback: playback, timeline: timeline, empty: "这首歌还没有歌词", prominent: true)
                            .id(item.trackID)
                    } else {
                        VStack(spacing: 12) {
                            Image(systemName: "music.note")
                                .font(.system(size: 36))
                                .foregroundStyle(ink.opacity(0.2))
                            Text("沉浸播放中")
                                .font(.headline)
                                .foregroundStyle(ink.opacity(0.45))
                            Text("点击右上角「歌词」展开歌词")
                                .font(.caption)
                                .foregroundStyle(ink.opacity(0.35))
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    private func queueDrawer(width: CGFloat, height: CGFloat) -> some View {
        let drawerHeight = max(320, height - 180)
        return VStack(spacing: 0) {
            MacQueueView(client: client, playback: playback, showsHeader: true, onClose: {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.82)) {
                    showQueue = false
                }
            })
            .padding(18)
        }
        .frame(width: width, height: drawerHeight)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(.ultraThinMaterial)
        )
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(dark ? Color.black.opacity(0.35) : Color.white.opacity(0.50))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(ink.opacity(dark ? 0.15 : 0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(dark ? 0.45 : 0.12), radius: 28, x: -6, y: 12)
        .padding(.trailing, 28)
    }

    private var controls: some View {
        VStack(spacing: 18) {
            HStack(spacing: 12) {
                Text(macPlaybackClock(playback.currentTime)).frame(width: 45, alignment: .trailing)
                PlaybackSlider(playback: playback).tint(ink.opacity(0.85))
                Text(playback.duration > 0 ? macPlaybackClock(playback.duration) : "—:—")
                    .frame(width: 45, alignment: .leading)
            }
            .font(.caption.monospacedDigit()).foregroundStyle(ink.opacity(0.55))
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
                            .foregroundStyle(dark ? .black : .white).frame(width: 56, height: 56)
                            .background(ink, in: Circle())
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
        guard let item = playback.currentItem, !isPodcast else { return }
        if let data = try? await client.authorizedData(path: "api/v1/tracks/\(item.trackID)/cover"),
           !Task.isCancelled {
            palette = MacArtworkPalette.extract(data)
        } else if !Task.isCancelled {
            palette = .neutral
        }
        if let lyrics = try? await client.lyrics(trackID: item.trackID), !Task.isCancelled {
            timeline = LyricTimeline(lyrics: lyrics)
        }
    }
}

private struct MacArtworkPalette: Equatable {
    let hue: CGFloat
    let saturation: CGFloat
    let secondHue: CGFloat
    static let neutral = Self(hue: 0.08, saturation: 0.2, secondHue: 0.10)

    func colors(dark: Bool) -> [Color] {
        let saturation = dark ? min(0.65, max(0.18, saturation * 0.7)) : min(0.28, max(0.10, saturation * 0.34))
        return [
            Color(nsColor: NSColor(calibratedHue: hue, saturation: saturation, brightness: dark ? 0.27 : 0.97, alpha: 1)),
            Color(nsColor: NSColor(calibratedHue: secondHue, saturation: saturation * 0.65, brightness: dark ? 0.16 : 0.94, alpha: 1))
        ]
    }

    static func extract(_ data: Data) -> Self {
        guard let image = NSBitmapImageRep(data: data), image.pixelsWide > 0, image.pixelsHigh > 0 else { return .neutral }
        var buckets: [Int: (weight: CGFloat, hue: CGFloat, saturation: CGFloat)] = [:]
        for y in stride(from: 0, to: image.pixelsHigh, by: max(1, image.pixelsHigh / 28)) {
            for x in stride(from: 0, to: image.pixelsWide, by: max(1, image.pixelsWide / 28)) {
                guard let color = image.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
                      color.alphaComponent > 0.5, color.brightnessComponent > 0.12,
                      color.brightnessComponent < 0.95, color.saturationComponent > 0.10 else { continue }
                let hue = color.hueComponent
                let saturation = color.saturationComponent
                let weight = 0.3 + saturation
                let key = Int(hue * 24)
                let old = buckets[key] ?? (0, 0, 0)
                buckets[key] = (old.weight + weight, old.hue + hue * weight, old.saturation + saturation * weight)
            }
        }
        let ranked = buckets.values.sorted { $0.weight > $1.weight }
        guard let first = ranked.first else { return .neutral }
        let hue = first.hue / first.weight
        let second = ranked.first { abs($0.hue / $0.weight - hue) > 0.12 }
        return Self(hue: hue, saturation: first.saturation / first.weight,
            secondHue: second.map { $0.hue / $0.weight } ?? hue)
    }
}
