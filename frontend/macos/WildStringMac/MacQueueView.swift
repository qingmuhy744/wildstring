import CoreNetwork
import CorePlayback
import SwiftUI

struct MacQueueView: View {
    let client: WildstringClient
    let playback: PlaybackService
    @State private var selection: UUID?

    private var entries: [PlaybackService.Item] { playback.playbackItems }
    private var podcastsOnly: Bool { !entries.isEmpty && entries.allSatisfy { $0.trackID.hasPrefix("podcast_ep_") } }

    var body: some View {
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Text("播放队列").font(.headline)
                    Text("\(entries.count) \(podcastsOnly ? "集" : "项")").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        if let id = playback.currentItem?.id {
                            selection = id
                            withAnimation { proxy.scrollTo(id, anchor: .center) }
                        }
                    } label: {
                        Image(systemName: "scope")
                    }
                    .buttonStyle(.borderless)
                    .help("定位当前播放")
                    .disabled(playback.currentItem == nil)
                }
                Text(playback.isShuffled ? "随机播放顺序 · 拖动可调整" : "拖动调整顺序 · 双击播放")
                    .font(.caption).foregroundStyle(.secondary)
                List(selection: $selection) {
                    ForEach(Array(entries.enumerated()), id: \.element.id) { position, item in
                        row(item, position: position)
                            .tag(item.id)
                            .id(item.id)
                            .contentShape(Rectangle())
                            .onTapGesture(count: 2) { play(item) }
                            .contextMenu { actions(item, position: position) }
                            .listRowInsets(EdgeInsets(top: 5, leading: 4, bottom: 5, trailing: 4))
                            .listRowSeparator(.hidden)
                    }
                    .onMove { offsets, destination in
                        playback.movePlaybackEntries(fromOffsets: offsets, toOffset: destination)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .overlay {
                    if entries.isEmpty {
                        ContentUnavailableView("队列是空的", systemImage: "text.line.first.and.arrowtriangle.forward",
                            description: Text("从曲库或每日推荐挑几首歌加入。"))
                    }
                }
            }
        }
    }

    private func row(_ item: PlaybackService.Item, position: Int) -> some View {
        let current = item.id == playback.currentItem?.id
        return HStack(spacing: 9) {
            Image(systemName: "line.3.horizontal")
                .font(.caption2).foregroundStyle(.tertiary)
                .help("拖动调整顺序")
            Button { play(item) } label: {
                ZStack {
                    MacCover(client: client, trackID: item.hasCover ? item.trackID : nil, side: 34,
                        placeholder: item.trackID.hasPrefix("podcast_ep_") ? "antenna.radiowaves.left.and.right" : "music.note")
                    if current {
                        RoundedRectangle(cornerRadius: 6).fill(.black.opacity(0.45))
                        Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                            .font(.caption).foregroundStyle(.white)
                    }
                }.frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .help(current ? (playback.isPlaying ? "暂停" : "继续播放") : "播放 \(item.title)")
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(.callout.weight(current ? .semibold : .regular))
                    .foregroundStyle(current ? MacTheme.accentDeep : Color.primary)
                    .lineLimit(item.trackID.hasPrefix("podcast_ep_") ? 2 : 1)
                Text(item.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Text(current ? (playback.isPlaying ? "播放中" : "已暂停") : String(format: "%02d", position + 1))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(current ? MacTheme.accentDeep : Color.secondary)
            Menu { actions(item, position: position) } label: {
                Image(systemName: "ellipsis").frame(width: 24, height: 28)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel("\(item.title)的队列操作")
        }
        .padding(.horizontal, 6).padding(.vertical, 5)
        .background(current ? MacTheme.accent.opacity(0.12) : Color.clear,
            in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private func actions(_ item: PlaybackService.Item, position: Int) -> some View {
        Button(item.id == playback.currentItem?.id ? (playback.isPlaying ? "暂停" : "继续播放") : "立即播放") {
            play(item)
        }
        if let current = entries.firstIndex(where: { $0.id == playback.currentItem?.id }) {
            Button(podcastsOnly ? "移到下一集" : "移到下一首") { move(position, to: current + 1) }
                .disabled(position == current || position == current + 1)
        }
        Divider()
        Button("上移") { move(position, to: position - 1) }.disabled(position == 0)
        Button("下移") { move(position, to: position + 2) }.disabled(position == entries.count - 1)
        Divider()
        Button("从队列移除", role: .destructive) {
            if let index = playback.items.firstIndex(where: { $0.id == item.id }) {
                playback.removeQueueEntry(at: index)
            }
        }.disabled(item.id == playback.currentItem?.id)
    }

    private func move(_ position: Int, to destination: Int) {
        playback.movePlaybackEntries(fromOffsets: IndexSet(integer: position), toOffset: destination)
    }

    private func play(_ item: PlaybackService.Item) {
        if item.id == playback.currentItem?.id {
            playback.togglePlayPause()
        } else if let index = playback.items.firstIndex(where: { $0.id == item.id }) {
            playback.playQueueEntry(at: index)
        }
    }
}
