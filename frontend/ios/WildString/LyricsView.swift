import CoreNetwork
import CorePlayback
import SwiftUI

/// Scrolling lyrics with current-line highlight, tap-to-seek and manual-scroll
/// follow recovery.
@MainActor
struct LyricsPane: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var timeline: LyricTimeline?
    @State private var isLoading = true
    @State private var isFollowing = true
    @State private var loadedTrackID: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if let timeline {
                        ForEach(Array(timeline.lines.enumerated()), id: \.offset) {
                            index, line in
                            Text(line.text.isEmpty ? " " : line.text)
                                .font(
                                    .system(
                                        size: 17,
                                        weight: index == highlightedIndex ? .semibold : .regular
                                    )
                                )
                                .foregroundStyle(
                                    index == highlightedIndex ? Color.primary : Color.secondary
                                )
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(index)
                                .contentShape(Rectangle())
                                .onTapGesture { seekToLine(index) }
                        }
                    }
                }
                .padding(.vertical, 60)
                .padding(.horizontal, 24)
            }
            .simultaneousGesture(
                DragGesture().onChanged { value in
                    if abs(value.translation.height) > 8 {
                        isFollowing = false
                    }
                }
            )
            .onChange(of: highlightedIndex) { _, newValue in
                guard isFollowing, let newValue else { return }
                withAnimation(.easeInOut(duration: 0.25)) {
                    proxy.scrollTo(newValue, anchor: .center)
                }
            }
            .overlay(alignment: .bottom) {
                if !isFollowing, timeline?.isSynced == true {
                    Button {
                        isFollowing = true
                        if let index = highlightedIndex {
                            withAnimation { proxy.scrollTo(index, anchor: .center) }
                        }
                    } label: {
                        Text("回到当前歌词")
                            .font(.footnote.bold())
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .padding(.bottom, 12)
                }
            }
            .overlay {
                if isLoading {
                    ProgressView()
                } else if let timeline, timeline.isEmpty {
                    ContentUnavailableView("没有歌词", systemImage: "text.quote")
                }
            }
        }
        .task(id: playback.currentItem?.id) { await load() }
    }

    private var highlightedIndex: Int? {
        timeline?.currentIndex(at: playback.currentTime)
    }

    private func load() async {
        guard let trackID = playback.currentItem?.trackID else {
            timeline = nil
            loadedTrackID = nil
            isLoading = false
            return
        }
        if loadedTrackID == trackID, timeline != nil { return }
        isLoading = true
        isFollowing = true
        defer { isLoading = false }
        do {
            let loaded = try await client.lyrics(trackID: trackID)
            guard playback.currentItem?.trackID == trackID else { return }
            timeline = LyricTimeline(lyrics: loaded)
            loadedTrackID = trackID
        } catch {
            guard playback.currentItem?.trackID == trackID else { return }
            timeline = LyricTimeline(lyrics: Lyrics(kind: "none", lines: []))
            loadedTrackID = trackID
        }
    }

    private func seekToLine(_ index: Int) {
        guard let timeline, timeline.isSynced,
            let time = timeline.lines[index].time
        else { return }
        playback.seek(to: time)
        isFollowing = true
    }
}
