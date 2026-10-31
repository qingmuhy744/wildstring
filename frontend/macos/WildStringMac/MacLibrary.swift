import CoreNetwork
import CorePlayback
import SwiftUI

struct MacMusicView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var query = ""
    @State private var tracks: [Track] = []
    @State private var message: String?

    var body: some View {
        List(tracks) { track in
            Button {
                play(track)
            } label: {
                HStack(spacing: 10) {
                    MacCover(client: client, trackID: track.hasCover ? track.id : nil, side: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(track.title).lineLimit(1)
                        Text(track.artists.joined(separator: " / "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    if playback.currentItem?.trackID == track.id {
                        Image(systemName: "speaker.wave.2.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)
        }
        .navigationTitle("音乐")
        .searchable(text: $query, prompt: "歌曲、艺人或专辑")
        .overlay {
            if tracks.isEmpty, message == nil, !query.isEmpty {
                ContentUnavailableView.search(text: query)
            } else if tracks.isEmpty, let message {
                ContentUnavailableView("无法加载曲库", systemImage: "music.note", description: Text(message))
            }
        }
        .task(id: query) { await load() }
    }

    private func load() async {
        do {
            let text = query.trimmingCharacters(in: .whitespaces)
            if !text.isEmpty {
                try? await Task.sleep(for: .milliseconds(280))
                guard !Task.isCancelled else { return }
            }
            tracks = try await client.tracks(limit: 80, query: text.isEmpty ? nil : text).items
            message = nil
        } catch {
            message = "曲库暂时无法加载"
        }
    }

    private func play(_ track: Track) {
        guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
        playback.play(
            items: tracks.map { item in
                PlaybackService.Item(
                    trackID: item.id,
                    title: item.title,
                    artist: item.artists.joined(separator: " / "),
                    album: item.album,
                    hasCover: item.hasCover,
                    streamPath: "api/v1/tracks/\(item.id)/stream"
                )
            },
            startingAt: index
        )
    }
}

struct MacDiscoverView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var summary: ListeningSummary?
    @State private var rankings: [RankingRow] = []
    @State private var scope = "personal"
    @State private var period = "30d"

    var body: some View {
        List {
            if let summary {
                Section("收听") {
                    LabeledContent("播放次数", value: "\(summary.playCount)")
                    LabeledContent("听过的歌", value: "\(summary.tracksPlayed)")
                    LabeledContent("收藏", value: "\(summary.favorites)")
                }
            }
            Section("排行") {
                Picker("范围", selection: $scope) {
                    Text("我的").tag("personal")
                    Text("大家").tag("community")
                }
                .pickerStyle(.segmented)
                Picker("时间", selection: $period) {
                    Text("7 天").tag("7d")
                    Text("30 天").tag("30d")
                    Text("全部").tag("all")
                }
                ForEach(rankings) { row in
                    Button {
                        play(row.track)
                    } label: {
                        Text("\(row.rank). \(row.track.title)")
                            .lineLimit(1)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .navigationTitle("发现")
        .task { await reload() }
        .onChange(of: scope) { _, _ in Task { await reload() } }
        .onChange(of: period) { _, _ in Task { await reload() } }
    }

    private func reload() async {
        summary = try? await client.listeningSummary()
        rankings = (try? await client.rankings(scope: scope, period: period, metric: "plays"))?.items ?? []
    }

    private func play(_ track: Track) {
        let items = rankings.map(\.track)
        guard let index = items.firstIndex(where: { $0.id == track.id }) else { return }
        playback.play(
            items: items.map { item in
                PlaybackService.Item(
                    trackID: item.id,
                    title: item.title,
                    artist: item.artists.joined(separator: " / "),
                    album: item.album,
                    hasCover: item.hasCover,
                    streamPath: "api/v1/tracks/\(item.id)/stream"
                )
            },
            startingAt: index
        )
    }
}

struct MacPodcastsView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var shows: [PodcastSummary] = []
    @State private var detail: PodcastDetail?
    @State private var resume: PodcastEpisode?

    var body: some View {
        List {
            if detail == nil {
                ForEach(shows) { show in
                    Button(show.title) { Task { await open(show.id) } }
                        .buttonStyle(.plain)
                }
            } else if let detail {
                Section {
                    Button(detail.podcast.followed ? "取消订阅" : "订阅") {
                        Task { await toggle(detail.podcast) }
                    }
                    Button("返回节目列表") { self.detail = nil }
                }
                Section(detail.podcast.title) {
                    ForEach(detail.episodes) { episode in
                        Button(episode.title) { choose(episode, in: detail.episodes) }
                            .buttonStyle(.plain)
                    }
                }
            }
        }
        .navigationTitle("电台")
        .task { await loadShows() }
        .confirmationDialog("从上次的位置继续？", isPresented: Binding(
            get: { resume != nil },
            set: { if !$0 { resume = nil } }
        )) {
            Button("继续") {
                if let episode = resume, let detail {
                    start(episode, in: detail.episodes, at: Double(episode.positionSeconds))
                }
                resume = nil
            }
            Button("从头播放") {
                if let episode = resume, let detail {
                    start(episode, in: detail.episodes, at: 0)
                }
                resume = nil
            }
        }
    }

    private func loadShows() async {
        shows = (try? await client.podcasts(followed: true)) ?? []
    }

    private func open(_ id: String) async {
        detail = try? await client.podcast(id: id)
    }

    private func toggle(_ show: PodcastSummary) async {
        try? await client.setPodcastFollowed(id: show.id, followed: !show.followed)
        await open(show.id)
    }

    private func choose(_ episode: PodcastEpisode, in episodes: [PodcastEpisode]) {
        let remaining = episode.durationSeconds - episode.positionSeconds
        if episode.positionSeconds > 15, episode.durationSeconds == 0 || remaining > 30 {
            resume = episode
        } else {
            start(episode, in: episodes, at: 0)
        }
    }

    private func start(_ episode: PodcastEpisode, in episodes: [PodcastEpisode], at position: Double) {
        guard let index = episodes.firstIndex(where: { $0.id == episode.id }) else { return }
        playback.play(
            items: episodes.map { item in
                PlaybackService.Item(
                    trackID: "podcast_ep_\(item.id)",
                    title: item.title,
                    artist: "电台",
                    streamPath: "api/v1/podcasts/episodes/\(item.id)/stream?proxy=1&cache=1"
                )
            },
            startingAt: index,
            position: position
        )
    }
}

struct MacSettingsView: View {
    let session: MacSession
    @AppStorage("menuBarPlayerEnabled") private var menuBarPlayerEnabled = true
    @AppStorage("desktopLyricsClickThrough") private var clickThrough = false

    var body: some View {
        Form {
            Toggle("在菜单栏显示播放器", isOn: $menuBarPlayerEnabled)
            Text("关掉后，右边状态项里的野弦图标会消失。播放仍可从窗口和「控制」菜单操作。")
                .font(.callout)
                .foregroundStyle(.secondary)
            Toggle("桌面歌词穿透点击", isOn: $clickThrough)
            Button("打开桌面歌词") {
                NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
            }
            Button("退出登录", role: .destructive) {
                Task { await session.logout() }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("设置")
        .padding()
    }
}
