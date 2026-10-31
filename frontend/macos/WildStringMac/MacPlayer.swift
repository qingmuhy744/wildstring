import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI

struct MacCover: View {
    let client: WildstringClient
    let trackID: String?
    var side: CGFloat = 44
    var cornerRadius: CGFloat = 6
    var placeholder = "music.note"

    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: placeholder)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.secondary.opacity(0.12))
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .task(id: trackID) { await load() }
    }

    private func load() async {
        image = nil
        guard let trackID,
            let data = try? await client.authorizedData(path: "api/v1/tracks/\(trackID)/cover"),
            let loaded = NSImage(data: data)
        else { return }
        image = loaded
    }
}

struct MacTransportBar: View {
    let session: MacSession
    let client: WildstringClient
    let playback: PlaybackService

    private var isPodcast: Bool {
        playback.currentItem?.trackID.hasPrefix("podcast_ep_") == true
    }

    var body: some View {
        GeometryReader { geo in
            let sideWidth = min(320, geo.size.width * 0.26)
            HStack(spacing: 20) {
                HStack(spacing: 12) {
                    if let item = playback.currentItem {
                        Button { session.showFullscreen = true } label: {
                            HStack(spacing: 12) {
                                MacCover(client: client, trackID: item.hasCover ? item.trackID : nil, side: 52,
                                    placeholder: isPodcast ? "antenna.radiowaves.left.and.right" : "music.note")
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item.title).font(.callout.weight(.semibold)).lineLimit(1)
                                    Text(item.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }.buttonStyle(.plain).help("全屏播放")
                        if let favorites = session.favorites, !isPodcast {
                            Button { Task { await favorites.toggle(item.trackID) } } label: {
                                Image(systemName: favorites.isFavorite(item.trackID) ? "heart.fill" : "heart")
                                    .foregroundStyle(favorites.isFavorite(item.trackID) ? MacTheme.accentDeep : Color.secondary)
                                    .frame(width: 28, height: 32)
                            }.buttonStyle(.plain).help(favorites.isFavorite(item.trackID) ? "取消红心" : "红心")
                        }
                    } else {
                        Image(systemName: "music.note").frame(width: 52, height: 52)
                            .background(MacTheme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                        Text("选择一首歌开始播放").font(.callout).foregroundStyle(.secondary)
                        Spacer()
                    }
                }.frame(width: sideWidth, alignment: .leading)

                VStack(spacing: 7) {
                    HStack(spacing: 18) {
                        if isPodcast {
                            MacPlaybackRateMenu(playback: playback).frame(width: 28)
                        } else {
                            transportButton("shuffle", help: "随机", active: playback.isShuffled) { playback.toggleShuffle() }
                        }
                        transportButton(isPodcast ? "gobackward.15" : "backward.fill", help: isPodcast ? "后退 15 秒" : "上一首") {
                            if isPodcast { playback.seek(to: max(0, playback.currentTime - 15)) } else { playback.previous() }
                        }
                        Button { playback.togglePlayPause() } label: {
                            Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                                .font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                                .frame(width: 36, height: 36).background(MacTheme.accentDeep, in: Circle())
                        }.buttonStyle(.plain).help(playback.isPlaying ? "暂停" : "播放").disabled(playback.currentItem == nil)
                        transportButton(isPodcast ? "goforward.30" : "forward.fill", help: isPodcast ? "前进 30 秒" : "下一首") {
                            if isPodcast { playback.seek(to: playback.currentTime + 30) } else { playback.next() }
                        }
                        if isPodcast {
                            Color.clear.frame(width: 28, height: 1)
                        } else {
                            transportButton(playback.repeatMode == .one ? "repeat.1" : "repeat", help: "循环",
                                active: playback.repeatMode != .off) { playback.cycleRepeatMode() }
                        }
                    }
                    HStack(spacing: 9) {
                        Text(macPlaybackClock(playback.currentTime)).frame(width: isPodcast ? 54 : 38, alignment: .trailing)
                        PlaybackSlider(playback: playback)
                        Text(playback.duration > 0 ? macPlaybackClock(playback.duration) : "—:—")
                            .frame(width: isPodcast ? 54 : 38, alignment: .leading)
                    }.font(.caption.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
                    if let message = playback.errorMessage ?? playback.podcastProgressMessage {
                        Text(message).font(.caption2).foregroundStyle(.orange).lineLimit(1)
                    }
                }
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)

                HStack(spacing: 10) {
                    Spacer(minLength: 0)
                    if !isPodcast {
                        transportButton("quote.bubble", help: "歌词", active: session.showLyrics) { session.showLyrics.toggle() }
                    }
                    transportButton("list.number", help: "播放队列", active: session.showQueue) { session.showQueue.toggle() }
                    transportButton("arrow.up.left.and.arrow.down.right", help: "全屏播放") { session.showFullscreen = true }
                    if !isPodcast {
                        transportButton("captions.bubble", help: session.desktopLyricsVisible ? "关闭桌面歌词" : "打开桌面歌词",
                            active: session.desktopLyricsVisible) {
                            NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
                        }
                    }
                }.frame(width: sideWidth, alignment: .trailing)
            }
            .padding(.horizontal, 20)
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .frame(height: playback.errorMessage == nil && playback.podcastProgressMessage == nil ? 94 : 110)
        .background(.regularMaterial)
    }

    private func transportButton(
        _ symbol: String,
        help: String,
        active: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 16))
                .foregroundStyle(active ? MacTheme.accentDeep : Color.secondary)
                .frame(width: 28, height: 30)
        }
        .buttonStyle(.borderless)
        .help(help)
        .disabled(playback.currentItem == nil && symbol != "quote.bubble" && symbol != "list.number" && symbol != "captions.bubble")
    }
}

struct MacPlayerInspector: View {
    let session: MacSession
    let client: WildstringClient
    let playback: PlaybackService

    @State private var timeline: LyricTimeline?
    @State private var lyricTrackID: String?
    @State private var focus: InspectorFocus = .lyrics

    private enum InspectorFocus: Hashable {
        case lyrics
        case queue
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if session.showLyrics && session.showQueue {
                Picker("正在看", selection: $focus) {
                    Text("歌词").tag(InspectorFocus.lyrics)
                    Text("队列").tag(InspectorFocus.queue)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            if session.showLyrics && (!session.showQueue || focus == .lyrics) {
                lyrics
            }
            if session.showQueue && (!session.showLyrics || focus == .queue) {
                queue
            }
        }
        .padding(16)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
        .task(id: playback.currentItem?.trackID) { await loadLyrics() }
        .onChange(of: session.showLyrics) { _, showing in
            if showing { focus = .lyrics }
        }
        .onChange(of: session.showQueue) { _, showing in
            if showing { focus = .queue }
        }
    }

    @ViewBuilder
    private var lyrics: some View {
        if playback.currentItem?.trackID.hasPrefix("podcast_ep_") == true {
            VStack(alignment: .leading, spacing: 12) {
                Text("播客单集")
                    .font(.headline)
                Text("播客没有歌词。底部按钮提供后退 15 秒和前进 30 秒，队列里可以切换单集。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            VStack(alignment: .leading, spacing: 14) {
                if let item = playback.currentItem {
                    HStack(spacing: 10) {
                        MacCover(client: client, trackID: item.hasCover ? item.trackID : nil, side: 48)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title).font(.headline).lineLimit(1)
                            Text(item.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                MacLyricScroll(playback: playback, timeline: timeline, empty: playback.currentItem == nil ? "选一首歌后，歌词会显示在这里" : "这首歌没有歌词")
            }
        }
    }

    private var queue: some View {
        MacQueueView(client: client, playback: playback)
    }

    private func loadLyrics() async {
        guard let trackID = playback.currentItem?.trackID, !trackID.hasPrefix("podcast_ep_") else {
            timeline = nil
            lyricTrackID = nil
            return
        }
        guard lyricTrackID != trackID else { return }
        lyricTrackID = trackID
        if let lyrics = try? await client.lyrics(trackID: trackID) {
            timeline = LyricTimeline(lyrics: lyrics)
        } else {
            timeline = nil
        }
    }
}

func macPlaybackClock(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let total = Int(seconds)
    if total >= 3600 { return String(format: "%d:%02d:%02d", total / 3600, (total / 60) % 60, total % 60) }
    return String(format: "%d:%02d", total / 60, total % 60)
}

/// Ignores slider write-backs that AppKit emits while applying a new playback
/// time. Those calls used to `seek` during layout (`_NSDetectedLayoutRecursion`).
struct PlaybackSlider: View {
    let playback: PlaybackService
    @State private var isScrubbing = false
    @State private var scrubTime = 0.0

    var body: some View {
        Slider(
            value: Binding(
                get: { isScrubbing ? scrubTime : playback.duration > 0 ? playback.currentTime : 0 },
                set: { newValue in
                    guard isScrubbing else { return }
                    scrubTime = newValue
                }
            ),
            in: 0...max(playback.duration, 1),
            onEditingChanged: { editing in
                if editing {
                    if !isScrubbing {
                        scrubTime = playback.currentTime
                    }
                    isScrubbing = true
                } else if isScrubbing {
                    let target = scrubTime
                    isScrubbing = false
                    if abs(target - playback.currentTime) > 0.25 {
                        playback.seek(to: target)
                    }
                }
            }
        )
        .disabled(playback.duration <= 0)
    }
}

struct MenuBarPlayer: View {
    let session: MacSession
    @Environment(\.openWindow) private var openWindow
    @AppStorage("macAppearance") private var appearance = "system"

    private var isPodcast: Bool {
        session.playback?.currentItem?.trackID.hasPrefix("podcast_ep_") == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let playback = session.playback, let item = playback.currentItem, let client = session.client {
                HStack {
                    Label(isPodcast ? "播客" : "音乐", systemImage: isPodcast ? "antenna.radiowaves.left.and.right" : "waveform")
                    Spacer()
                    Text(playback.isBuffering ? "正在缓冲" : playback.isPlaying ? "正在播放" : "已暂停")
                }.font(.caption).foregroundStyle(.secondary)
                Button { openPlayer() } label: {
                    HStack(alignment: .top, spacing: 12) {
                        MacCover(client: client, trackID: item.hasCover ? item.trackID : nil, side: 56,
                            placeholder: isPodcast ? "antenna.radiowaves.left.and.right" : "music.note")
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item.title).font(.system(size: 15, weight: .semibold)).lineLimit(3)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(item.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            if let album = item.album, !album.isEmpty {
                                Text(album).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.multilineTextAlignment(.leading)
                }.buttonStyle(.plain).help(item.title)
                VStack(spacing: 3) {
                    PlaybackSlider(playback: playback)
                    HStack {
                        Text(macPlaybackClock(playback.currentTime))
                        Spacer()
                        Text(playback.duration > 0 ? macPlaybackClock(playback.duration) : "—:—")
                    }.font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                HStack(spacing: 22) {
                    if isPodcast {
                        MacPlaybackRateMenu(playback: playback)
                    } else {
                        Button { playback.toggleShuffle() } label: {
                            Image(systemName: "shuffle")
                                .foregroundStyle(playback.isShuffled ? MacTheme.accentDeep : Color.secondary)
                        }.help("随机播放")
                    }
                    Spacer(minLength: 0)
                    Button {
                        if isPodcast { playback.seek(to: max(0, playback.currentTime - 15)) }
                        else { playback.previous() }
                    } label: {
                        Image(systemName: isPodcast ? "gobackward.15" : "backward.fill")
                    }.help(isPodcast ? "后退 15 秒" : "上一首")
                    Button { playback.togglePlayPause() } label: {
                        Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                            .font(.title3).foregroundStyle(.white).frame(width: 42, height: 42)
                            .background(MacTheme.accentDeep, in: Circle())
                    }.help(playback.isPlaying ? "暂停" : "播放")
                    Button {
                        if isPodcast { playback.seek(to: playback.currentTime + 30) }
                        else { playback.next() }
                    } label: {
                        Image(systemName: isPodcast ? "goforward.30" : "forward.fill")
                    }.help(isPodcast ? "前进 30 秒" : "下一首")
                    Spacer(minLength: 0)
                    if isPodcast {
                        Button { openPlayer() } label: { Image(systemName: "doc.text") }.help("本期内容")
                    } else {
                        Button { playback.cycleRepeatMode() } label: {
                            Image(systemName: playback.repeatMode == .one ? "repeat.1" : "repeat")
                                .foregroundStyle(playback.repeatMode != .off ? MacTheme.accentDeep : Color.secondary)
                        }.help("循环播放")
                    }
                }.buttonStyle(.plain)
                HStack {
                    MacSleepMenu(playback: playback, podcast: isPodcast)
                    Spacer()
                    if !isPodcast {
                        Button(session.desktopLyricsVisible ? "关闭桌面歌词" : "桌面歌词") {
                            NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
                        }
                    }
                }.font(.caption).buttonStyle(.borderless)
                if let index = playback.playbackItems.firstIndex(where: { $0.id == item.id }),
                   playback.playbackItems.indices.contains(index + 1) {
                    Divider()
                    VStack(alignment: .leading, spacing: 6) {
                        Text(isPodcast ? "下一集" : "下一首").font(.caption).foregroundStyle(.secondary)
                        Text(playback.playbackItems[index + 1].title).font(.callout).lineLimit(2)
                    }
                }
                if let message = playback.errorMessage ?? playback.podcastProgressMessage {
                    Text(message).font(.caption).foregroundStyle(.orange)
                }
                Button { openPlayer() } label: {
                    HStack {
                        Text(isPodcast ? "打开单集详情" : "打开完整播放器")
                        Spacer()
                        Image(systemName: "arrow.up.forward")
                    }
                }.buttonStyle(.borderless)
            } else {
                Text("还没有在播放").foregroundStyle(.secondary)
                Button("打开野弦") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
            }
        }
        .padding(18).frame(width: 360).tint(MacTheme.accentDeep)
        .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
    }

    private func openPlayer() {
        session.showFullscreen = true
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct DesktopLyricsView: View {
    let session: MacSession
    @AppStorage("desktopLyricsClickThrough") private var clickThrough = false
    @State private var timeline: LyricTimeline?
    @State private var loadedTrackID: String?

    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        ZStack(alignment: .topLeading) {
            Group {
                if let playback = session.playback, let timeline, !timeline.isEmpty {
                    TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !playback.isPlaying)) { _ in
                        if let index = timeline.currentIndex(at: playback.lyricTime) {
                            MacTimedLyricText(line: timeline.lines[index], time: playback.lyricTime,
                                font: .system(size: lyricSize(timeline.lines[index].text), weight: .semibold), highlight: .white,
                                inactive: .white.opacity(0.85), centered: true)
                        } else {
                            Text(playback.currentItem?.title ?? "野弦")
                                .font(.system(size: 26, weight: .semibold)).foregroundStyle(.white)
                        }
                    }
                } else {
                    Text(session.playback?.currentItem?.title ?? "野弦")
                        .font(.system(size: 26, weight: .semibold)).foregroundStyle(.white)
                        .lineLimit(2).minimumScaleFactor(0.7)
                }
            }
            .shadow(color: .black.opacity(0.6), radius: 3, y: 1)
            .padding(.horizontal, 32).padding(.vertical, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Button {
                session.desktopLyricsVisible = false
                dismissWindow(id: "desktop-lyrics")
            } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85)).frame(width: 20, height: 20)
            }.buttonStyle(.plain).help("关闭桌面歌词").accessibilityLabel("关闭桌面歌词")
                .padding(6)
        }
        .frame(width: 540, height: 72)
        .background(.black.opacity(0.62), in: RoundedRectangle(cornerRadius: 10))
        .background(DesktopLyricsWindow(clickThrough: clickThrough))
        .ignoresSafeArea()
        .onAppear { session.desktopLyricsVisible = true }
        .onDisappear { session.desktopLyricsVisible = false }
        .task(id: session.playback?.currentItem?.trackID) { await load() }
    }

    private func lyricSize(_ text: String) -> CGFloat {
        let width = (text as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 26, weight: .semibold)]).width
        return min(26, max(15, 26 * 476 / max(1, width)))
    }

    private func load() async {
        guard let client = session.client,
            let trackID = session.playback?.currentItem?.trackID,
            !trackID.hasPrefix("podcast_ep_")
        else {
            timeline = nil
            loadedTrackID = nil
            return
        }
        guard loadedTrackID != trackID else { return }
        loadedTrackID = trackID
        timeline = nil
        if let lyrics = try? await client.lyrics(trackID: trackID) {
            timeline = LyricTimeline(lyrics: lyrics)
        }
    }
}

private struct DesktopLyricsWindow: NSViewRepresentable {
    var clickThrough: Bool

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let clickThrough = clickThrough
        DispatchQueue.main.async { apply(to: view, clickThrough: clickThrough) }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        let clickThrough = clickThrough
        DispatchQueue.main.async { apply(to: view, clickThrough: clickThrough) }
    }

    private func apply(to view: NSView, clickThrough: Bool) {
        guard let window = view.window else { return }
        let background = NSColor.clear
        if window.isOpaque { window.isOpaque = false }
        if window.backgroundColor != background { window.backgroundColor = background }
        if window.level != .floating { window.level = .floating }
        let behavior: NSWindow.CollectionBehavior = [
            .canJoinAllSpaces, .fullScreenAuxiliary, .stationary,
        ]
        if window.collectionBehavior != behavior { window.collectionBehavior = behavior }
        if !window.isMovableByWindowBackground { window.isMovableByWindowBackground = true }
        if window.ignoresMouseEvents != clickThrough { window.ignoresMouseEvents = clickThrough }
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            window.standardWindowButton(type)?.isHidden = true
        }
        if !window.styleMask.intersection([.titled, .miniaturizable, .resizable]).isEmpty {
            window.styleMask.remove([.titled, .miniaturizable, .resizable])
        }
        if window.titleVisibility != .hidden { window.titleVisibility = .hidden }
        if !window.titlebarAppearsTransparent { window.titlebarAppearsTransparent = true }
    }
}
