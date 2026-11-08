import CoreNetwork
import CorePlayback
import SwiftUI

/// Current playback queue with jump, drag reorder and swipe removal.
@MainActor
struct QueueView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @Environment(\.dismiss) private var dismiss
    @State private var actionError: String?

    private var isPodcast: Bool {
        playback.currentItem?.trackID.hasPrefix("podcast_ep_") == true
    }

    private var currentEpisodeID: String? {
        guard let trackID = playback.currentItem?.trackID else { return nil }
        return PlaybackService.podcastEpisodeID(trackID)
    }

    private var autoPreview: [PlaybackService.Item] {
        guard let cloud = playback.podcastCloud else {
            return playback.podcastAutoPreview(limit: 3)
        }
        let upcoming = cloud.upcoming(after: currentEpisodeID)
        let anchor = upcoming.last.map { "podcast_ep_\($0.episodeId)" } ?? playback.currentItem?.trackID
        return playback.podcastAutoPreview(limit: 3, anchorTrackID: anchor)
    }

    var body: some View {
        NavigationStack {
            Group {
                if isPodcast, let cloud = playback.podcastCloud {
                    podcastQueueList(cloud: cloud)
                } else {
                    musicQueueList
                }
            }
            .navigationTitle(isPodcast ? "待播队列" : "播放队列")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    EditButton()
                }
            }
        }
    }

    private var musicQueueList: some View {
        List {
            ForEach(Array(playback.items.enumerated()), id: \.element.id) { index, item in
                Button {
                    Haptics.tap()
                    playback.playQueueEntry(at: index)
                } label: {
                    HStack(spacing: 10) {
                        CoverImage(client: client, trackID: item.trackID, size: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title)
                                .font(.subheadline)
                                .lineLimit(1)
                                .foregroundStyle(
                                    playback.currentIndex == index
                                        ? Color.wildAccent : Color.primary
                                )
                            Text(item.artist)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        if playback.currentIndex == index {
                            Image(systemName: "speaker.wave.2.fill")
                                .font(.caption)
                                .foregroundStyle(Color.wildAccent)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
            .onMove { offsets, destination in
                playback.moveQueueEntries(fromOffsets: offsets, toOffset: destination)
            }
            .onDelete { offsets in
                for index in offsets.sorted(by: >) where index != playback.currentIndex {
                    playback.removeQueueEntry(at: index)
                }
            }
        }
        .listStyle(.plain)
    }

    private func podcastQueueList(cloud: PodcastCloudQueue) -> some View {
        List {
            if cloud.conflict != nil {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(PodcastCloudQueue.conflictMessage)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                        HStack(spacing: 12) {
                            Button("使用服务器上的队列") { cloud.adoptServerQueue() }
                            Button("用本机覆盖") { cloud.overwriteWithLocal() }
                        }
                    }
                }
            } else if let syncError = cloud.syncError {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(syncError)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                        Button("重试") { Task { await cloud.retrySync() } }
                    }
                }
            }
            if let actionError {
                Section {
                    Text(actionError)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
            Section("待播队列") {
                if cloud.loading, cloud.items.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("正在同步待播队列…").foregroundStyle(.secondary)
                    }
                } else if cloud.items.isEmpty {
                    Text(playback.podcastAutoContinueEnabled ? "播完会接下一集" : "已关闭，播完即停")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(cloud.items) { item in
                        Button {
                            Task { await playQueued(item.episodeId, cloud: cloud) }
                        } label: {
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(cloud.title(for: item.episodeId))
                                        .font(.subheadline)
                                        .lineLimit(2)
                                        .foregroundStyle(
                                            item.episodeId == currentEpisodeID
                                                ? Color.wildAccent : Color.primary
                                        )
                                }
                                Spacer(minLength: 8)
                                if item.episodeId == currentEpisodeID {
                                    Text("正在收听")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    .onMove { offsets, destination in
                        cloud.moveItems(from: offsets, to: destination)
                    }
                }
            }
            if !autoPreview.isEmpty {
                Section {
                    ForEach(autoPreview) { item in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(item.title)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                            Spacer(minLength: 8)
                            Button("加入待播") {
                                guard let episodeID = PlaybackService.podcastEpisodeID(item.trackID) else { return }
                                cloud.enqueueEpisode(episodeID, next: false, currentEpisodeID: currentEpisodeID)
                            }
                            .font(.caption)
                            .buttonStyle(.borderless)
                        }
                    }
                } header: {
                    Text("自动续播")
                } footer: {
                    Text("不会写入待播队列")
                }
            }
        }
        .task { await cloud.refreshQueue() }
    }

    private func playQueued(_ episodeID: String, cloud: PodcastCloudQueue) async {
        guard let item = await cloud.playbackItem(for: episodeID) else {
            actionError = "这集暂时打不开。待播队列还在，可以重试。"
            return
        }
        actionError = nil
        playback.playPodcastEpisode(item)
    }
}
