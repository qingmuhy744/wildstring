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
    @State private var podcastCover: URL?

    var body: some View {
        Group {
            if let podcastCover {
                MacPodcastArtwork(url: podcastCover, side: side)
            } else if let image {
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
        podcastCover = nil
        guard let trackID else { return }
        if trackID.hasPrefix("podcast_ep_") {
            guard let episode = try? await client.podcastEpisode(id: String(trackID.dropFirst("podcast_ep_".count))),
                let detail = try? await client.podcast(id: episode.podcastId), !Task.isCancelled else { return }
            podcastCover = detail.podcast.coverURL
            return
        }
        guard
            let data = try? await client.authorizedData(path: "api/v1/tracks/\(trackID)/cover"),
            let loaded = NSImage(data: data), !Task.isCancelled
        else { return }
        image = loaded
    }
}

struct MacTransportBar: View {
    let session: MacSession
    let client: WildstringClient
    let playback: PlaybackService

    @State private var podcastDuration: Double = 0
    @State private var previousVolume: Float = 1

    private var isPodcast: Bool {
        playback.currentItem?.trackID.hasPrefix("podcast_ep_") == true
    }

    private var effectiveDuration: Double {
        playback.duration > 0 ? playback.duration : (isPodcast ? podcastDuration : 0)
    }

    private var trailingTimeText: String {
        guard effectiveDuration > 0 else { return "—:—" }
        if isPodcast {
            let remaining = max(0, effectiveDuration - playback.currentTime)
            return "-\(macPlaybackClock(remaining))"
        }
        return macPlaybackClock(effectiveDuration)
    }

    var body: some View {
        GeometryReader { geo in
            let sideWidth = min(330, geo.size.width * 0.27)
            HStack(spacing: 20) {
                HStack(spacing: 12) {
                    if let item = playback.currentItem {
                        Button { session.showFullscreen = true } label: {
                            HStack(spacing: 12) {
                                MacCover(client: client, trackID: item.hasCover || isPodcast ? item.trackID : nil, side: 48,
                                    placeholder: isPodcast ? "antenna.radiowaves.left.and.right" : "music.note")
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(MacTheme.ink).lineLimit(1)
                                    Text(
                                        isPodcast && (item.album?.isEmpty == false)
                                            ? "\(item.artist) · \(item.album ?? "")"
                                            : item.artist
                                    )
                                    .font(MacTheme.caption)
                                    .foregroundStyle(MacTheme.muted)
                                    .lineLimit(1)
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
                            MacSleepMenu(playback: playback, podcast: true, iconOnly: true)
                        } else {
                            transportButton("shuffle", help: "随机", active: playback.isShuffled) { playback.toggleShuffle() }
                        }
                        transportButton(isPodcast ? "gobackward.15" : "backward.fill", help: isPodcast ? "后退 15 秒" : "上一首") {
                            if isPodcast { playback.seek(to: max(0, playback.currentTime - 15)) } else { playback.previous() }
                        }
                        Button { playback.togglePlayPause() } label: {
                            Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                                .font(.system(size: 14, weight: .semibold)).foregroundStyle(MacTheme.onAccent)
                                .frame(width: 38, height: 38).background(MacTheme.accent, in: Circle())
                        }.buttonStyle(.plain).help(playback.isPlaying ? "暂停" : "播放").disabled(playback.currentItem == nil)
                        transportButton(isPodcast ? "goforward.30" : "forward.fill", help: isPodcast ? "前进 30 秒" : "下一首") {
                            if isPodcast { playback.seek(to: playback.currentTime + 30) } else { playback.next() }
                        }
                        if isPodcast {
                            MacPlaybackRateMenu(playback: playback)
                        } else {
                            transportButton(playback.repeatMode == .one ? "repeat.1" : "repeat", help: "循环",
                                active: playback.repeatMode != .off) { playback.cycleRepeatMode() }
                        }
                    }
                    HStack(spacing: 10) {
                        Text(macPlaybackClock(playback.currentTime)).frame(width: isPodcast ? 54 : 38, alignment: .trailing)
                        PlaybackSlider(playback: playback, fallbackDuration: effectiveDuration)
                        Text(trailingTimeText)
                            .frame(width: isPodcast ? 58 : 38, alignment: .leading)
                    }.font(MacTheme.mono(10)).foregroundStyle(MacTheme.faint).lineLimit(1)
                    if let message = playback.errorMessage ?? playback.podcastProgressMessage {
                        Text(message).font(.caption2).foregroundStyle(.orange).lineLimit(2).help(message)
                    }
                }
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)

                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    HStack(spacing: 6) {
                        Button {
                            if playback.volume > 0.01 {
                                previousVolume = playback.volume
                                playback.volume = 0
                            } else {
                                playback.volume = previousVolume > 0.05 ? previousVolume : 0.8
                            }
                        } label: {
                            Image(
                                systemName: playback.volume <= 0.01
                                    ? "speaker.slash.fill"
                                    : playback.volume < 0.5 ? "speaker.wave.1.fill" : "speaker.wave.2.fill"
                            )
                            .font(.system(size: 13))
                            .foregroundStyle(MacTheme.muted)
                            .frame(width: 22, height: 26)
                        }
                        .buttonStyle(.plain)
                        .help(playback.volume <= 0.01 ? "取消静音" : "静音")

                        Slider(
                            value: Binding(
                                get: { Double(playback.volume) },
                                set: { playback.volume = Float($0) }
                            ),
                            in: 0...1
                        )
                        .controlSize(.mini)
                        .frame(width: 72)
                        .tint(MacTheme.muted)
                        .accessibilityLabel("音量")
                    }
                    .padding(.trailing, 4)

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
        .frame(height: playback.errorMessage == nil && playback.podcastProgressMessage == nil ? 84 : 116)
        .background(MacTheme.panel)
        .overlay(alignment: .top) {
            Rectangle().fill(MacTheme.border.opacity(0.5)).frame(height: 1)
        }
        .task(id: playback.currentItem?.trackID) {
            podcastDuration = 0
            guard let trackID = playback.currentItem?.trackID, trackID.hasPrefix("podcast_ep_") else { return }
            let episodeID = String(trackID.dropFirst("podcast_ep_".count))
            if let episode = try? await client.podcastEpisode(id: episodeID), !Task.isCancelled {
                podcastDuration = Double(max(0, episode.durationSeconds))
            }
        }
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
                .foregroundStyle(active ? MacTheme.accentDeep : MacTheme.muted)
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

    private var showingQueue: Bool {
        session.showQueue && (!session.showLyrics || focus == .queue)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: showingQueue ? "list.number" : "quote.bubble")
                    .foregroundStyle(MacTheme.accentDeep)
                    .frame(width: 32, height: 32)
                    .background(MacTheme.accentSoft, in: RoundedRectangle(cornerRadius: 10))
                Text(showingQueue ? "播放队列" : "歌词")
                    .font(MacTheme.display(19)).foregroundStyle(MacTheme.ink)
                if showingQueue {
                    Text(
                        "\(playback.playbackItems.count) " +
                        (playback.currentItem?.trackID.hasPrefix("podcast_ep_") == true ? "集" : "项")
                    )
                    .font(MacTheme.micro)
                    .foregroundStyle(MacTheme.muted)
                }
                Spacer()
                Button {
                    session.showLyrics = false
                    session.showQueue = false
                } label: {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .medium))
                        .foregroundStyle(MacTheme.muted).frame(width: 26, height: 26)
                        .background(MacTheme.canvas, in: Circle())
                }.buttonStyle(.plain).help("关闭侧栏").accessibilityLabel("关闭侧栏")
            }
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
        .background(MacTheme.panel)
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
        MacQueueView(client: client, playback: playback, showsHeader: false)
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

/// Scrubbable playback bar with buffered track visualization and a larger hit target.
struct PlaybackSlider: View {
    let playback: PlaybackService
    var fallbackDuration: Double = 0
    @State private var isScrubbing = false
    @State private var scrubTime = 0.0

    private var totalDuration: Double {
        playback.duration > 0 ? playback.duration : fallbackDuration
    }

    private var displayTime: Double {
        isScrubbing ? scrubTime : (totalDuration > 0 ? min(playback.currentTime, totalDuration) : 0)
    }

    private var playedRatio: CGFloat {
        guard totalDuration > 0 else { return 0 }
        return CGFloat(min(1, max(0, displayTime / totalDuration)))
    }

    private var bufferedRatio: CGFloat {
        guard totalDuration > 0 else { return 0 }
        return CGFloat(min(1, max(0, playback.bufferedTime / totalDuration)))
    }

    var body: some View {
        GeometryReader { geo in
            let width = max(1, geo.size.width)
            let thumbSize: CGFloat = 14
            let playedWidth = width * playedRatio
            let bufferedWidth = max(playedWidth, width * bufferedRatio)

            ZStack(alignment: .leading) {
                Capsule()
                    .fill(MacTheme.border)
                    .frame(height: 5)

                if bufferedWidth > 0 {
                    Capsule()
                        .fill(MacTheme.accent.opacity(0.28))
                        .frame(width: bufferedWidth, height: 5)
                }

                if playedWidth > 0 {
                    Capsule()
                        .fill(MacTheme.accentDeep)
                        .frame(width: playedWidth, height: 5)
                }

                if totalDuration > 0 {
                    Circle()
                        .fill(MacTheme.raised)
                        .frame(width: thumbSize, height: thumbSize)
                        .overlay(
                            Circle()
                                .strokeBorder(MacTheme.accentDeep, lineWidth: 2)
                        )
                        .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
                        .offset(x: min(max(0, playedWidth - thumbSize / 2), max(0, width - thumbSize)))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard totalDuration > 0 else { return }
                        let ratio = min(1, max(0, Double(value.location.x / width)))
                        scrubTime = ratio * totalDuration
                        isScrubbing = true
                    }
                    .onEnded { value in
                        guard totalDuration > 0 else { return }
                        let ratio = min(1, max(0, Double(value.location.x / width)))
                        let target = ratio * totalDuration
                        isScrubbing = false
                        if abs(target - playback.currentTime) > 0.1 {
                            playback.seek(to: target)
                        }
                    }
            )
        }
        .frame(height: 18)
        .disabled(totalDuration <= 0)
        .accessibilityLabel("播放进度")
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
                        MacCover(client: client, trackID: item.hasCover || isPodcast ? item.trackID : nil, side: 56,
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
                            .font(.title3).foregroundStyle(MacTheme.onAccent).frame(width: 42, height: 42)
                            .background(MacTheme.accent, in: Circle())
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
        .preferredColorScheme(MacAppearance.resolvedColorScheme(for: appearance))
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

    var body: some View {
        ZStack(alignment: .topLeading) {
            Group {
                if let playback = session.playback, let timeline, !timeline.isEmpty {
                    TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !playback.isPlaying)) { _ in
                        if let index = timeline.currentIndex(at: playback.lyricTime) {
                            DesktopLyricLine(line: timeline.lines[index], time: playback.lyricTime)
                        } else {
                            title
                        }
                    }
                } else {
                    title
                }
            }
            .shadow(color: .black.opacity(0.6), radius: 3, y: 1)
            .padding(.horizontal, 34).padding(.vertical, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay { DesktopLyricsDragArea() }
            Button { session.desktopLyrics.close() } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85)).frame(width: 24, height: 24)
            }.buttonStyle(.plain).help("关闭桌面歌词").accessibilityLabel("关闭桌面歌词")
                .padding(4)
        }
        .frame(width: 540, height: 112)
        .background(.black.opacity(0.62), in: RoundedRectangle(cornerRadius: 10))
        .onAppear { session.desktopLyrics.setClickThrough(clickThrough) }
        .onChange(of: clickThrough) { _, value in session.desktopLyrics.setClickThrough(value) }
        .task(id: session.playback?.currentItem?.trackID) {
            timeline = nil
            guard let client = session.client, let id = session.playback?.currentItem?.trackID,
                !id.hasPrefix("podcast_ep_") else { return }
            if let lyrics = try? await client.lyrics(trackID: id), !Task.isCancelled {
                timeline = LyricTimeline(lyrics: lyrics)
            }
        }
    }

    private var title: some View {
        Text(session.playback?.currentItem?.title ?? "野弦")
            .font(.system(size: 24, weight: .semibold)).foregroundStyle(.white)
            .lineLimit(2).minimumScaleFactor(0.7)
    }
}

struct DesktopLyricLine: View {
    let line: LyricTimeline.Line
    let time: Double
    @AppStorage("lyricsShowTranslation") private var showTranslation = true
    @AppStorage("lyricsShowRomanization") private var showRomanization = false

    var body: some View {
        VStack(spacing: 6) {
            let width = (line.text as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 24, weight: .semibold)]).width
            MacTimedLyricText(line: line, time: time,
                font: .system(size: min(24, max(14, 24 * 472 / max(1, width))), weight: .semibold),
                highlight: .white, inactive: .white.opacity(0.85), centered: true)
            if showTranslation, let text = line.translation, !text.isEmpty {
                Text(text).font(.system(size: 15)).foregroundStyle(.white.opacity(0.9))
                    .lineLimit(2).minimumScaleFactor(0.8)
            }
            if showRomanization, let text = line.romanization, !text.isEmpty {
                Text(text).font(.system(size: 13)).foregroundStyle(.white.opacity(0.75))
                    .lineLimit(1).minimumScaleFactor(0.8)
            }
        }.multilineTextAlignment(.center)
    }
}
