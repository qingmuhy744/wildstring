import CoreNetwork
import CorePlayback
import SwiftUI

extension PodcastEpisode {
    var playbackItem: PlaybackService.Item {
        PlaybackService.Item(
            trackID: "podcast_ep_\(id)",
            title: title,
            artist: "电台",
            album: nil,
            hasCover: false,
            streamPath: "api/v1/podcasts/episodes/\(id)/stream?proxy=1&cache=1"
        )
    }
}

@MainActor
struct PodcastsView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var followedOnly = true
    @State private var shows: [PodcastSummary] = []
    @State private var isLoading = true
    @State private var message: String?

    var body: some View {
        NavigationStack {
            List {
                if shows.isEmpty, !isLoading {
                    ContentUnavailableView(
                        followedOnly ? "还没有订阅" : "没有节目",
                        systemImage: "antenna.radiowaves.left.and.right",
                        description: Text(followedOnly ? "可以改看全部节目，或先在网页端添加订阅。" : "服务器上还没有播客。")
                    )
                }
                ForEach(shows) { show in
                    NavigationLink {
                        PodcastDetailView(client: client, playback: playback, podcastID: show.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(show.title).lineLimit(1)
                            Text(subtitle(show))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                if let message {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .navigationTitle("电台")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Picker("范围", selection: $followedOnly) {
                        Text("已订阅").tag(true)
                        Text("全部").tag(false)
                    }
                    .pickerStyle(.segmented)
                }
            }
            .overlay {
                if isLoading, shows.isEmpty { ProgressView() }
            }
            .miniPlayer(playback, client: client)
            .task(id: followedOnly) { await load() }
            .refreshable { await load() }
        }
    }

    private func subtitle(_ show: PodcastSummary) -> String {
        let author = show.author.isEmpty ? "电台" : show.author
        return "\(author) · \(show.unplayedEpisodes)/\(show.totalEpisodes) 未听完"
    }

    private func load() async {
        isLoading = shows.isEmpty
        defer { isLoading = false }
        do {
            shows = try await client.podcasts(followed: followedOnly)
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }
}

@MainActor
private struct PodcastDetailView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let podcastID: String

    @State private var detail: PodcastDetail?
    @State private var message: String?
    @State private var resumeEpisode: PodcastEpisode?

    var body: some View {
        List {
            if let detail {
                Section {
                    Text(detail.podcast.description.isEmpty ? "没有简介" : detail.podcast.description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button(detail.podcast.followed ? "取消订阅" : "订阅") {
                        Task { await toggleFollow(detail.podcast) }
                    }
                }
                Section("单集") {
                    ForEach(detail.episodes) { episode in
                        Button {
                            choose(episode, in: detail.episodes)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(episode.title).lineLimit(2)
                                Text(progressText(episode))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            } else if message == nil {
                ProgressView()
            }
            if let message {
                Text(message).font(.caption).foregroundStyle(.red)
            }
        }
        .navigationTitle(detail?.podcast.title ?? "节目")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .confirmationDialog(
            "从上次的位置继续？",
            isPresented: Binding(
                get: { resumeEpisode != nil },
                set: { if !$0 { resumeEpisode = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("继续") {
                if let episode = resumeEpisode, let detail {
                    start(episode, in: detail.episodes, at: Double(episode.positionSeconds))
                }
                resumeEpisode = nil
            }
            Button("从头播放") {
                if let episode = resumeEpisode, let detail {
                    start(episode, in: detail.episodes, at: 0)
                }
                resumeEpisode = nil
            }
            Button("取消", role: .cancel) { resumeEpisode = nil }
        }
    }

    private func progressText(_ episode: PodcastEpisode) -> String {
        let total = max(episode.durationSeconds, 0)
        let position = min(max(episode.positionSeconds, 0), total > 0 ? total : episode.positionSeconds)
        if position > 0, total > 0 {
            return "听到 \(clock(position)) / \(clock(total))"
        }
        if total > 0 { return clock(total) }
        return "时长未知"
    }

    private func clock(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    private func choose(_ episode: PodcastEpisode, in episodes: [PodcastEpisode]) {
        let remaining = episode.durationSeconds - episode.positionSeconds
        if episode.positionSeconds > 15, episode.durationSeconds == 0 || remaining > 30 {
            resumeEpisode = episode
        } else {
            start(episode, in: episodes, at: 0)
        }
    }

    private func start(_ episode: PodcastEpisode, in episodes: [PodcastEpisode], at position: Double) {
        guard let index = episodes.firstIndex(where: { $0.id == episode.id }) else { return }
        Haptics.tap()
        playback.play(items: episodes.map(\.playbackItem), startingAt: index, position: position)
    }

    private func load() async {
        do {
            detail = try await client.podcast(id: podcastID)
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func toggleFollow(_ show: PodcastSummary) async {
        do {
            try await client.setPodcastFollowed(id: show.id, followed: !show.followed)
            await load()
        } catch {
            message = ErrorText.message(for: error)
        }
    }
}
