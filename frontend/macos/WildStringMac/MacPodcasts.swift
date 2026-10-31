import CoreNetwork
import CorePlayback
import SwiftUI

struct MacPodcastsView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var shows: [PodcastSummary] = []
    @State private var detail: PodcastDetail?
    @State private var resume: PodcastEpisode?
    @State private var followedOnly = true
    @State private var message: String?
    @State private var detailMessage: String?
    @State private var selectedShowID: String?
    @State private var loadingShows = true
    @State private var loadingDetail = false
    @State private var choosingShow = false
    @State private var showQuery = ""
    @State private var descriptionExpanded = false

    var body: some View {
        GeometryReader { geo in
            if geo.size.width >= 780 {
                HStack(spacing: 0) {
                    showList.frame(width: 260)
                    Divider()
                    detailPane.frame(maxWidth: .infinity)
                }
            } else {
                detailPane
                    .safeAreaInset(edge: .top, spacing: 0) {
                        HStack {
                            Button { choosingShow = true } label: {
                                Label("选择节目", systemImage: "list.bullet")
                            }
                            Spacer()
                            Text("\(shows.count) 个节目").font(.caption).foregroundStyle(.secondary)
                        }.padding(14).background(.bar)
                    }
            }
        }
        .navigationTitle("电台")
        .toolbar {
            ToolbarItemGroup {
                Picker("范围", selection: $followedOnly) {
                    Text("已订阅").tag(true)
                    Text("全部").tag(false)
                }
                .pickerStyle(.segmented)
                .frame(width: 138)
                Button {
                    Task { await loadShows() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("刷新节目")
                .disabled(loadingShows)
            }
        }
        .task(id: followedOnly) { await loadShows() }
        .sheet(isPresented: $choosingShow) {
            VStack(spacing: 0) {
                HStack { Spacer(); Button("关闭") { choosingShow = false } }
                    .padding(12)
                showList
            }.frame(width: 360, height: 520)
        }
        .confirmationDialog("从上次的位置继续？", isPresented: Binding(
            get: { resume != nil },
            set: { if !$0 { resume = nil } }
        ), titleVisibility: .visible) {
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
            Button("取消", role: .cancel) { resume = nil }
        } message: {
            if let episode = resume {
                Text("已听 \(macPodcastClock(episode.positionSeconds))，共 \(macPodcastClock(episode.durationSeconds))。")
            }
        }
    }

    private var showList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(followedOnly ? "我的订阅" : "全部节目")
                    .font(.headline)
                Spacer()
                if loadingShows {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 10)
            TextField("搜索节目", text: $showQuery)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal, 14).padding(.bottom, 12)

            if let message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }

            if shows.isEmpty, !loadingShows {
                ContentUnavailableView(
                    followedOnly ? "还没有订阅" : "没有节目",
                    systemImage: "antenna.radiowaves.left.and.right",
                    description: Text(followedOnly ? "切换到“全部”查看可用节目。" : "可以先在网页端添加节目。")
                )
                .frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(shows.filter { showQuery.isEmpty || $0.title.localizedCaseInsensitiveContains(showQuery) || $0.author.localizedCaseInsensitiveContains(showQuery) }) { show in
                            MacPodcastShowRow(
                                show: show,
                                selected: selectedShowID == show.id
                            ) {
                                choosingShow = false
                                Task { await open(show.id) }
                            }
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 12)
                }
            }
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.45))
    }

    @ViewBuilder
    private var detailPane: some View {
        if loadingDetail {
            ProgressView("正在打开节目…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    podcastHeader(detail)
                    Divider()
                    HStack {
                        Text("全部单集").font(.headline)
                        Text("\(detail.episodes.count)").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Text("从新到旧").font(.caption).foregroundStyle(.secondary)
                    }
                    if detail.episodes.isEmpty {
                        ContentUnavailableView("还没有单集", systemImage: "waveform")
                            .frame(maxWidth: .infinity)
                    } else {
                        LazyVStack(spacing: 8) {
                            ForEach(detail.episodes) { episode in
                                MacPodcastEpisodeRow(
                                    episode: episode,
                                    current: playback.currentItem?.trackID == "podcast_ep_\(episode.id)",
                                    playing: playback.isPlaying,
                                    action: {
                                        if playback.currentItem?.trackID == "podcast_ep_\(episode.id)" {
                                            playback.togglePlayPause()
                                        } else {
                                            choose(episode, in: detail.episodes)
                                        }
                                    },
                                    next: { enqueue(episode, in: detail.podcast, next: true) },
                                    append: { enqueue(episode, in: detail.podcast, next: false) }
                                )
                            }
                        }
                    }
                }
                .frame(maxWidth: 860, alignment: .leading)
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        } else if let detailMessage {
            ContentUnavailableView("无法打开节目", systemImage: "wifi.exclamationmark",
                description: Text(detailMessage))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView(
                "选择一个节目",
                systemImage: "antenna.radiowaves.left.and.right",
                description: Text("左侧选择节目后，这里会显示简介和单集。")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func podcastHeader(_ detail: PodcastDetail) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 16) {
                MacPodcastArtwork(url: detail.podcast.coverURL, side: 88)
                VStack(alignment: .leading, spacing: 7) {
                    Text(detail.podcast.title)
                        .font(.system(size: 25, weight: .semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(detail.podcast.author.isEmpty ? "电台" : detail.podcast.author)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Text("\(detail.episodes.count) 集 · \(detail.podcast.unplayedEpisodes) 集未听完")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 10) {
                if let next = detail.episodes.first(where: canResume) ?? detail.episodes.first {
                    Button { choose(next, in: detail.episodes) } label: {
                        Label(canResume(next) ? "继续收听" : "播放最新一集", systemImage: "play.fill")
                    }.buttonStyle(.borderedProminent)
                }
                Button(detail.podcast.followed ? "取消订阅" : "订阅") {
                    Task { await toggle(detail.podcast) }
                }
                .buttonStyle(.bordered)
            }
            if !detail.podcast.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(detail.podcast.description)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .lineSpacing(4)
                    .lineLimit(descriptionExpanded ? nil : 3)
                    .textSelection(.enabled)
                Button(descriptionExpanded ? "收起简介" : "展开简介") { descriptionExpanded.toggle() }
                    .buttonStyle(.plain).font(.caption).foregroundStyle(MacTheme.accentDeep)
            }
            if let detailMessage {
                Text(detailMessage)
                    .font(.callout)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func loadShows() async {
        loadingShows = true
        do {
            let loaded = try await client.podcasts(followed: followedOnly)
            guard !Task.isCancelled else { return }
            shows = loaded
            message = nil
            if let selectedShowID, loaded.contains(where: { $0.id == selectedShowID }) {
                await open(selectedShowID)
            } else if let first = loaded.first {
                await open(first.id)
            } else {
                selectedShowID = nil
                detail = nil
            }
        } catch {
            shows = []
            message = MacErrorText.message(for: error)
        }
        loadingShows = false
    }

    private func open(_ id: String) async {
        selectedShowID = id
        descriptionExpanded = false
        loadingDetail = true
        defer { if selectedShowID == id { loadingDetail = false } }
        do {
            let loaded = try await client.podcast(id: id)
            guard selectedShowID == id, !Task.isCancelled else { return }
            detail = loaded
            detailMessage = nil
        } catch {
            guard selectedShowID == id, !Task.isCancelled else { return }
            detail = nil
            detailMessage = MacErrorText.message(for: error)
        }
    }

    private func toggle(_ show: PodcastSummary) async {
        do {
            try await client.setPodcastFollowed(id: show.id, followed: !show.followed)
            await loadShows()
        } catch {
            detailMessage = MacErrorText.message(for: error)
        }
    }

    private func choose(_ episode: PodcastEpisode, in episodes: [PodcastEpisode]) {
        if canResume(episode) {
            resume = episode
        } else {
            start(episode, in: episodes, at: 0)
        }
    }

    private func canResume(_ episode: PodcastEpisode) -> Bool {
        let position = max(0, episode.positionSeconds)
        let remaining = episode.durationSeconds - position
        return position > 15 && (episode.durationSeconds == 0 || remaining > 30)
    }

    private func start(_ episode: PodcastEpisode, in episodes: [PodcastEpisode], at position: Double) {
        guard let index = episodes.firstIndex(where: { $0.id == episode.id }) else { return }
        let show = detail?.podcast
        playback.play(
            items: episodes.map { item in
                PlaybackService.Item(
                    trackID: "podcast_ep_\(item.id)",
                    title: item.title,
                    artist: show?.author.isEmpty == false ? show?.author ?? "电台" : "电台",
                    album: show?.title,
                    streamPath: "api/v1/podcasts/episodes/\(item.id)/stream?proxy=1&cache=1"
                )
            },
            startingAt: index,
            position: position
        )
    }

    private func enqueue(_ episode: PodcastEpisode, in show: PodcastSummary, next: Bool) {
        let item = PlaybackService.Item(
            trackID: "podcast_ep_\(episode.id)", title: episode.title,
            artist: show.author.isEmpty ? show.title : show.author, album: show.title,
            streamPath: "api/v1/podcasts/episodes/\(episode.id)/stream?proxy=1&cache=1")
        if playback.enqueue(items: [item], next: next) {
            detailMessage = next ? "已安排为下一集播放" : "已加入播放队列"
        } else {
            detailMessage = playback.errorMessage
        }
    }
}

struct MacPodcastArtwork: View {
    let url: URL?
    var side: CGFloat
    var body: some View {
        AsyncImage(url: url) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            RoundedRectangle(cornerRadius: 10)
                .fill(MacTheme.accent.opacity(0.13))
                .overlay {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .font(.system(size: side * 0.32)).foregroundStyle(MacTheme.accentDeep)
                }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

private struct MacPodcastShowRow: View {
    let show: PodcastSummary
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                MacPodcastArtwork(url: show.coverURL, side: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(show.title)
                        .font(.callout.weight(selected ? .semibold : .regular))
                        .lineLimit(2)
                    Text(show.author.isEmpty ? "电台" : show.author)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text("\(show.unplayedEpisodes) 未听 · \(show.totalEpisodes) 集")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if show.followed {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(MacTheme.accentDeep)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? MacTheme.accent.opacity(0.16) : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private struct MacPodcastEpisodeRow: View {
    let episode: PodcastEpisode
    let current: Bool
    let playing: Bool
    let action: () -> Void
    let next: () -> Void
    let append: () -> Void

    var body: some View {
        HStack(spacing: 8) {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: current && playing ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 27))
                    .foregroundStyle(current ? MacTheme.accentDeep : Color.secondary)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 5) {
                    Text(episode.title)
                        .font(.callout.weight(current ? .semibold : .regular))
                        .lineLimit(3)
                    ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        Text(macPodcastDate(episode.pubDate))
                        Text(macPodcastProgressText(episode))
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(macPodcastDate(episode.pubDate))
                        Text(macPodcastProgressText(episode))
                    }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    if let progress = macPodcastProgress(episode) {
                        ProgressView(value: progress)
                            .tint(MacTheme.accentDeep)
                    }
                }
                Spacer(minLength: 8)
                if episode.positionSeconds > 0, episode.durationSeconds > 0,
                   episode.positionSeconds >= episode.durationSeconds {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(MacTheme.accentDeep)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(current ? MacTheme.accent.opacity(0.14) : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        Menu {
            Button("下一集播放", action: next)
            Button("加入播放队列", action: append)
        } label: {
            Image(systemName: "ellipsis").frame(width: 28, height: 30)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel("\(episode.title)的更多操作")
        }
        .padding(.vertical, 3)
        .overlay(alignment: .bottom) { Divider().padding(.leading, 52) }
    }
}

func macPodcastClock(_ seconds: Int) -> String {
    let total = max(0, seconds)
    if total >= 3600 {
        return String(format: "%d:%02d:%02d", total / 3600, (total / 60) % 60, total % 60)
    }
    return String(format: "%d:%02d", total / 60, total % 60)
}

private func macPodcastProgress(_ episode: PodcastEpisode) -> Double? {
    guard episode.durationSeconds > 0, episode.positionSeconds > 0 else { return nil }
    return min(1, Double(episode.positionSeconds) / Double(episode.durationSeconds))
}

private func macPodcastProgressText(_ episode: PodcastEpisode) -> String {
    if episode.durationSeconds <= 0 { return "时长未知" }
    if episode.positionSeconds > 0 {
        return "已听 \(macPodcastClock(episode.positionSeconds)) / \(macPodcastClock(episode.durationSeconds))"
    }
    return macPodcastClock(episode.durationSeconds)
}

func macPodcastDate(_ value: String) -> String {
    let iso = ISO8601DateFormatter()
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss Z"
    let date = iso.date(from: value) ?? formatter.date(from: value)
    return date?.formatted(.dateTime.year().month(.twoDigits).day(.twoDigits)) ?? "日期未提供"
}
