import CoreNetwork
import CorePlayback
import SwiftUI

struct MacQueueView: View {
    let client: WildstringClient
    let playback: PlaybackService
    var showsHeader = true
    var onClose: (() -> Void)? = nil
    @State private var selection: UUID?

    private var entries: [PlaybackService.Item] { playback.playbackItems }
    private var podcastsOnly: Bool { !entries.isEmpty && entries.allSatisfy { $0.trackID.hasPrefix("podcast_ep_") } }
    private var autoPreview: [PlaybackService.Item] {
        let cur = PlaybackService.podcastEpisodeID(playback.currentItem?.trackID ?? "")
        let anchor: String?
        if let last = playback.podcastCloud?.upcoming(after: cur).last {
            anchor = "podcast_ep_\(last.episodeId)"
        } else {
            anchor = playback.currentItem?.trackID
        }
        return playback.podcastAutoPreview(limit: 3, anchorTrackID: anchor)
    }

    var body: some View {
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: 10) {
                if showsHeader {
                    HStack(alignment: .firstTextBaseline) {
                        Text("播放队列").font(MacTheme.section(15))
                        Text("\(entries.count) \(podcastsOnly ? "集" : "项")")
                            .font(MacTheme.micro).foregroundStyle(MacTheme.muted)
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

                        if let onClose {
                            Button(action: onClose) {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 16))
                                    .foregroundStyle(MacTheme.muted)
                                    .frame(width: 22, height: 22)
                            }
                            .buttonStyle(.plain)
                            .help("收起队列（Esc）")
                            .accessibilityLabel("收起队列")
                        }
                    }
                }
                Text(playback.isShuffled ? "随机播放顺序 · 拖动可调整" : "拖动调整顺序 · 双击播放")
                    .font(MacTheme.micro).foregroundStyle(MacTheme.muted)
                // No native List selection: its square grey highlight ignores the row's rounded shape.
                List {
                    ForEach(Array(entries.enumerated()), id: \.element.id) { position, item in
                        row(item, position: position)
                            .id(item.id)
                            .contentShape(Rectangle())
                            .onTapGesture(count: 2) { play(item) }
                            .onTapGesture { selection = item.id }
                            .contextMenu { actions(item, position: position) }
                            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                            .listRowBackground(Color.clear)
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
                            description: Text(podcastsOnly ? "从电台单集挑几集加入。" : "从曲库或每日推荐挑几首歌加入。"))
                    }
                }

                if (podcastsOnly || playback.currentItem?.trackID.hasPrefix("podcast_ep_") == true), !autoPreview.isEmpty {
                    continuationSection
                }
            }
        }
    }

    private var continuationSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("自动续播")
                    .font(MacTheme.section(12))
                    .foregroundStyle(MacTheme.ink)
                Text("按规则续播 · 不会写入云端待播")
                    .font(MacTheme.micro)
                    .foregroundStyle(MacTheme.muted)
            }
            .padding(.top, 4)
            .padding(.horizontal, 8)

            ForEach(autoPreview) { item in
                HStack(spacing: 8) {
                    Text(item.title)
                        .font(MacTheme.caption)
                        .foregroundStyle(MacTheme.muted)
                        .lineLimit(1)
                    Spacer()
                    Button("+ 待播") {
                        if let epID = PlaybackService.podcastEpisodeID(item.trackID) {
                            let curID = PlaybackService.podcastEpisodeID(playback.currentItem?.trackID ?? "")
                            playback.podcastCloud?.enqueueEpisode(epID, next: false, currentEpisodeID: curID)
                        }
                    }
                    .buttonStyle(.plain)
                    .font(MacTheme.micro)
                    .foregroundStyle(MacTheme.accentDeep)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
            }
        }
        .padding(.vertical, 4)
        .background(MacTheme.panel, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(MacTheme.border, lineWidth: 1))
    }

    private func row(_ item: PlaybackService.Item, position: Int) -> some View {
        let current = item.id == playback.currentItem?.id
        let selected = selection == item.id
        return HStack(spacing: 9) {
            Image(systemName: "line.3.horizontal")
                .font(.caption2).foregroundStyle(.tertiary)
                .help("拖动调整顺序")
            Button { play(item) } label: {
                ZStack {
                    MacCover(client: client, trackID: item.trackID, side: 34,
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
                Text(item.title)
                    .font(.system(size: 13, weight: current ? .semibold : .regular))
                    .foregroundStyle(current ? MacTheme.accentDeep : MacTheme.ink)
                    .lineLimit(item.trackID.hasPrefix("podcast_ep_") ? 2 : 1)
                Text(item.artist).font(MacTheme.caption).foregroundStyle(MacTheme.muted).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Text(current ? (playback.isPlaying ? "播放中" : "已暂停") : String(format: "%02d", position + 1))
                .font(MacTheme.mono(10))
                .foregroundStyle(current ? MacTheme.accentDeep : MacTheme.faint)
            Menu { actions(item, position: position) } label: {
                Image(systemName: "ellipsis").frame(width: 24, height: 28)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel("\(item.title)的队列操作")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(current ? MacTheme.accentSoft : (selected ? MacTheme.oliveSoft : Color.clear),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(alignment: .leading) {
            if current {
                Capsule()
                    .fill(MacTheme.accent)
                    .frame(width: 3)
                    .padding(.vertical, 10)
            }
        }
        .padding(.vertical, 2)
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
