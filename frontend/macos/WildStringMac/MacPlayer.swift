import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI

struct MacCover: View {
    let client: WildstringClient
    let trackID: String?
    var side: CGFloat = 44

    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "music.note")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.secondary.opacity(0.12))
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 6))
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

struct MacPlayerPane: View {
    let session: MacSession
    let client: WildstringClient
    let playback: PlaybackService

    @State private var timeline: LyricTimeline?
    @State private var lyricTrackID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let item = playback.currentItem {
                HStack(spacing: 14) {
                    MacCover(
                        client: client,
                        trackID: item.hasCover ? item.trackID : nil,
                        side: 84
                    )
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title).font(.title3.bold()).lineLimit(2)
                        Text(item.artist).foregroundStyle(.secondary).lineLimit(1)
                        if let message = playback.podcastProgressMessage {
                            Text(message).font(.caption).foregroundStyle(.orange)
                        }
                    }
                    Spacer()
                }
                slider
                controls
                if session.showLyrics {
                    lyrics
                }
                if session.showQueue {
                    queue
                }
            } else {
                ContentUnavailableView("选择一首歌开始播放", systemImage: "music.note")
            }
        }
        .padding(20)
        .navigationTitle("正在播放")
        .task(id: playback.currentItem?.trackID) { await loadLyrics() }
    }

    private var slider: some View {
        VStack(spacing: 4) {
            Slider(
                value: Binding(
                    get: { playback.currentTime },
                    set: { playback.seek(to: $0) }
                ),
                in: 0...max(playback.duration, 1)
            )
            HStack {
                Text(clock(playback.currentTime))
                Spacer()
                Text(clock(playback.duration))
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
    }

    private var controls: some View {
        HStack(spacing: 18) {
            Button { playback.toggleShuffle() } label: {
                Image(systemName: "shuffle")
            }
            .foregroundStyle(playback.isShuffled ? Color.accentColor : Color.secondary)
            .help("随机")
            Button { playback.previous() } label: { Image(systemName: "backward.fill") }
                .help("上一首")
            Button { playback.togglePlayPause() } label: {
                Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                    .font(.title2)
            }
            .help(playback.isPlaying ? "暂停" : "播放")
            Button { playback.next() } label: { Image(systemName: "forward.fill") }
                .help("下一首")
            Button { playback.cycleRepeatMode() } label: {
                Image(systemName: playback.repeatMode == .one ? "repeat.1" : "repeat")
            }
            .foregroundStyle(playback.repeatMode == .off ? Color.secondary : Color.accentColor)
            .help("循环")
            Button {
                NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
            } label: {
                Image(systemName: "quote.bubble")
            }
            .help("桌面歌词")
        }
        .buttonStyle(.borderless)
    }

    private var lyrics: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if let timeline, !timeline.isEmpty {
                    let current = timeline.currentIndex(at: playback.currentTime)
                    ForEach(Array(timeline.lines.enumerated()), id: \.offset) { index, line in
                        Text(line.text.isEmpty ? " " : line.text)
                            .font(index == current ? .title3.bold() : .body)
                            .foregroundStyle(index == current ? Color.primary : Color.secondary)
                    }
                } else {
                    Text("这首歌没有歌词")
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var queue: some View {
        List {
            ForEach(Array(playback.items.enumerated()), id: \.element.id) { index, item in
                Button(item.title) { playback.playQueueEntry(at: index) }
                    .buttonStyle(.plain)
            }
        }
        .frame(minHeight: 160)
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

    private func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

struct MenuBarPlayer: View {
    let session: MacSession

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let playback = session.playback, let item = playback.currentItem, let client = session.client {
                HStack(spacing: 10) {
                    MacCover(client: client, trackID: item.hasCover ? item.trackID : nil, side: 48)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).font(.headline).lineLimit(1)
                        Text(item.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Slider(
                    value: Binding(
                        get: { playback.currentTime },
                        set: { playback.seek(to: $0) }
                    ),
                    in: 0...max(playback.duration, 1)
                )
                HStack {
                    Button { playback.previous() } label: { Image(systemName: "backward.fill") }
                    Button { playback.togglePlayPause() } label: {
                        Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                    }
                    Button { playback.next() } label: { Image(systemName: "forward.fill") }
                    Spacer()
                    Button("桌面歌词") {
                        NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
                    }
                }
                .buttonStyle(.borderless)
            } else {
                Text("还没有在播放")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(width: 280)
    }
}

struct DesktopLyricsView: View {
    let session: MacSession
    @AppStorage("desktopLyricsClickThrough") private var clickThrough = false
    @State private var timeline: LyricTimeline?
    @State private var loadedTrackID: String?

    var body: some View {
        Text(line)
            .font(.system(size: 32, weight: .semibold))
            .multilineTextAlignment(.center)
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.8), radius: 8, y: 2)
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(DesktopLyricsWindow(clickThrough: clickThrough))
            .task(id: session.playback?.currentItem?.trackID) { await load() }
    }

    private var line: String {
        guard let playback = session.playback, playback.currentItem != nil else { return "野弦" }
        guard let timeline, let index = timeline.currentIndex(at: playback.currentTime) else {
            return playback.currentItem?.title ?? "野弦"
        }
        let text = timeline.lines[index].text.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? (playback.currentItem?.title ?? "野弦") : text
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
        if let lyrics = try? await client.lyrics(trackID: trackID) {
            timeline = LyricTimeline(lyrics: lyrics)
        }
    }
}

private struct DesktopLyricsWindow: NSViewRepresentable {
    var clickThrough: Bool

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { apply(to: view) }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        apply(to: view)
    }

    private func apply(to view: NSView) {
        guard let window = view.window else { return }
        window.isOpaque = false
        window.backgroundColor = NSColor.black.withAlphaComponent(0.55)
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.isMovableByWindowBackground = true
        window.ignoresMouseEvents = clickThrough
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
    }
}
