import CoreNetwork
import CorePlayback
import SwiftUI

/// Scrolling lyrics. Positioning follows the shared lyric-view contract:
/// the current line stays centered when it can, the opening stays at the top,
/// and a short lyric block is centered as a whole.
@MainActor
struct LyricsPane: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var timeline: LyricTimeline?
    @State private var isLoading = true
    @State private var failed = false
    @State private var isFollowing = true
    @State private var browsing = false
    @State private var browseToken = 0
    @State private var loadedTrackID: String?
    @State private var contentHeight: CGFloat = 0
    @State private var programmaticUntil = Date.distantPast
    @State private var lastOffset: CGFloat?

    var body: some View {
        GeometryReader { geo in
            let viewport = geo.size.height
            let topMin: CGFloat = 24
            let short = contentHeight > 0 && contentHeight <= viewport - topMin * 2
            let pad = short ? max(topMin, (viewport - contentHeight) / 2) : topMin
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if let timeline, !failed {
                            ForEach(Array(timeline.lines.enumerated()), id: \.offset) { index, line in
                                Text(line.text.isEmpty ? " " : line.text)
                                    .font(.system(size: 17, weight: index == highlightedIndex ? .semibold : .regular))
                                    .foregroundStyle(index == highlightedIndex ? Color.primary : Color.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .id(index)
                                    .contentShape(Rectangle())
                                    .onTapGesture { seekToLine(index) }
                            }
                        }
                    }
                    .background {
                        GeometryReader { content in
                            Color.clear.preference(key: LyricBlockHeightKey.self, value: content.size.height)
                        }
                    }
                    .background {
                        GeometryReader { content in
                            Color.clear.preference(
                                key: LyricOffsetKey.self,
                                value: content.frame(in: .named("lyric-scroll")).minY
                            )
                        }
                    }
                    .padding(.top, pad)
                    .padding(.bottom, short ? pad : viewport / 2)
                    .padding(.horizontal, 24)
                }
                .coordinateSpace(name: "lyric-scroll")
                .onPreferenceChange(LyricBlockHeightKey.self) { contentHeight = $0 }
                .onPreferenceChange(LyricOffsetKey.self) { value in
                    if Date() < programmaticUntil {
                        lastOffset = value
                        return
                    }
                    if let lastOffset, abs(value - lastOffset) > 1 {
                        isFollowing = false
                        browsing = false
                        browseToken += 1
                    }
                    lastOffset = value
                }
                .simultaneousGesture(
                    DragGesture(minimumDistance: 8).onChanged { _ in
                        guard Date() >= programmaticUntil else { return }
                        isFollowing = false
                        browsing = true
                        browseToken += 1
                    }.onEnded { _ in
                        browsing = false
                        browseToken += 1
                    }
                )
                .onChange(of: highlightedIndex) { _, newValue in
                    guard isFollowing, let newValue, !short else { return }
                    reveal(newValue, proxy: proxy)
                }
                .onChange(of: isFollowing) { _, following in
                    guard following, let index = highlightedIndex, !short else { return }
                    reveal(index, proxy: proxy)
                }
                .overlay(alignment: .bottom) {
                    if !isFollowing, timeline?.isSynced == true, !failed {
                        Button("回到当前歌词") {
                            isFollowing = true
                            if let index = highlightedIndex { reveal(index, proxy: proxy) }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .padding(.bottom, 12)
                    }
                }
                .overlay {
                    if isLoading {
                        ProgressView("正在读取歌词")
                    } else if failed {
                        VStack(spacing: 12) {
                            Text("暂时无法读取歌词。网络恢复后可以重试。")
                                .font(.callout)
                                .multilineTextAlignment(.center)
                                .foregroundStyle(.secondary)
                            Button("重新读取") {
                                loadedTrackID = nil
                                Task { await load() }
                            }
                        }
                        .padding(24)
                    } else if let timeline, timeline.isEmpty {
                        ContentUnavailableView("没有歌词", systemImage: "text.quote")
                    }
                }
            }
        }
        .task(id: playback.currentItem?.id) { await load() }
        .task(id: "\(browseToken)-\(playback.isPlaying)-\(isFollowing)-\(browsing)") {
            guard !isFollowing, !browsing, playback.isPlaying, timeline?.isSynced == true else { return }
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            isFollowing = true
        }
    }

    private var highlightedIndex: Int? {
        guard !failed else { return nil }
        return timeline?.currentIndex(at: playback.currentTime)
    }

    private func reveal(_ index: Int, proxy: ScrollViewProxy) {
        programmaticUntil = Date().addingTimeInterval(0.6)
        withAnimation(.easeInOut(duration: 0.25)) {
            proxy.scrollTo(index, anchor: .center)
        }
    }

    private func load() async {
        guard let trackID = playback.currentItem?.trackID else {
            timeline = nil
            loadedTrackID = nil
            failed = false
            isLoading = false
            return
        }
        if loadedTrackID == trackID, timeline != nil, !failed { return }
        isLoading = true
        failed = false
        isFollowing = true
        programmaticUntil = Date().addingTimeInterval(0.8)
        defer { isLoading = false }
        do {
            let loaded = try await client.lyrics(trackID: trackID)
            guard playback.currentItem?.trackID == trackID else { return }
            timeline = LyricTimeline(lyrics: loaded)
            loadedTrackID = trackID
        } catch {
            guard playback.currentItem?.trackID == trackID else { return }
            timeline = nil
            failed = true
            loadedTrackID = trackID
        }
    }

    private func seekToLine(_ index: Int) {
        guard let timeline, timeline.isSynced, let time = timeline.lines[index].time else { return }
        playback.seek(to: time)
        isFollowing = true
    }
}

private struct LyricBlockHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct LyricOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
