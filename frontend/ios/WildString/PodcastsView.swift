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

    @State private var shows: [PodcastSummary] = []
    @State private var isLoading = true
    @State private var message: String?

    var body: some View {
        NavigationStack {
            List {
                let pendingCount = playback.podcastCloud?.unifiedPendingEpisodes.count ?? 0
                NavigationLink {
                    PodcastUnifiedQueueView(client: client, playback: playback)
                } label: {
                    HStack {
                        Label("待播列表", systemImage: "list.bullet")
                        Spacer()
                        if pendingCount > 0 {
                            Text("\(pendingCount)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if pendingCount > 0 {
                    Button {
                        playPendingQueue()
                    } label: {
                        Label("播放待播 (\(pendingCount))", systemImage: "play.fill")
                            .fontWeight(.semibold)
                    }
                }
                if let cloud = playback.podcastCloud {
                    PodcastCloudStatusIOS(cloud: cloud)
                }
                if shows.isEmpty, !isLoading {
                    ContentUnavailableView(
                        "还没有订阅",
                        systemImage: "antenna.radiowaves.left.and.right",
                        description: Text("点左上角的“探索”添加节目。")
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
                ToolbarItem(placement: .topBarLeading) {
                    NavigationLink {
                        PodcastDiscoverView(client: client, playback: playback)
                    } label: {
                        Label("探索", systemImage: "safari")
                    }
                }
            }
            .overlay {
                if isLoading, shows.isEmpty { ProgressView() }
            }
            .miniPlayer(playback, client: client)
            .task {
                await load()
                await playback.podcastCloud?.refreshPreferences()
            }
            .refreshable { await load() }
        }
    }

    private func subtitle(_ show: PodcastSummary) -> String {
        let author = show.author.isEmpty ? "电台" : show.author
        return show.unplayedEpisodes > 0
            ? "\(author) · 还有 \(show.unplayedEpisodes) 集可听"
            : "\(author) · 共 \(show.totalEpisodes) 集"
    }

    private func load() async {
        isLoading = shows.isEmpty
        defer { isLoading = false }
        do {
            shows = try await client.podcasts(followed: true)
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func playPendingQueue() {
        guard let first = playback.podcastCloud?.unifiedPendingEpisodes.first else { return }
        Task {
            if let item = await playback.podcastCloud?.playbackItem(for: first.episodeId) {
                playback.playPodcastEpisode(item)
            }
        }
    }
}

@MainActor
private struct PodcastDetailView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let podcastID: String

    @Environment(FavoritesModel.self) private var favorites
    @State private var detail: PodcastDetail?
    @State private var message: String?
    @State private var notice: String?
    @State private var resumeEpisode: PodcastEpisode?
    @State private var episodeFilter = "all"

    var body: some View {
        List {
            if let detail {
                Section {
                    Text(detail.podcast.description.isEmpty ? "没有简介" : detail.podcast.description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        Button(detail.podcast.followed ? "取消订阅" : "订阅") {
                            Task { await toggleFollow(detail.podcast) }
                        }
                        let pendingQueueCount = playback.podcastCloud?.unifiedPendingEpisodes.count ?? 0
                        if pendingQueueCount > 0 {
                            Button {
                                playPendingQueue()
                            } label: {
                                Label("播放待播 (\(pendingQueueCount))", systemImage: "play.fill")
                                    .fontWeight(.semibold)
                            }
                        }
                    }
                }
                Section {
                    PodcastIntakeSettingsIOS(playback: playback, podcastID: detail.podcast.id) {
                        applyContinuation(detail.episodes, show: detail.podcast)
                    }
                }
                if let cloud = playback.podcastCloud {
                    Section {
                        PodcastCloudStatusIOS(cloud: cloud)
                    }
                }
                Section {
                    Picker("单集筛选", selection: $episodeFilter) {
                        Text("全部").tag("all")
                        Text("未播").tag("unplayed")
                        Text("已播").tag("completed")
                        Text("收藏").tag("favorite")
                    }
                    .pickerStyle(.segmented)
                }
                Section("单集") {
                    let displayedEpisodes = filteredEpisodes(detail.episodes)
                    if displayedEpisodes.isEmpty {
                        Text("暂无符合筛选条件的单集")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(displayedEpisodes) { episode in
                        let isQueued = playback.podcastCloud?.isQueued(episodeID: episode.id) ?? false
                        let completed = isCompleted(episode)
                        let isFav = isFavorite(episode)
                        HStack(spacing: 8) {
                            Button {
                                if let cloud = playback.podcastCloud {
                                    if isQueued {
                                        cloud.removeEpisode(episode.id)
                                    } else {
                                        enqueue(episode, next: false)
                                    }
                                }
                            } label: {
                                Image(systemName: isQueued ? "checkmark.circle.fill" : "plus.circle")
                                    .font(.title3)
                                    .foregroundStyle(isQueued ? Color.secondary : Color.accentColor)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(isQueued ? "从待播移除" : "加入待播")

                            Button {
                                choose(episode, in: detail.episodes)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                                        if completed {
                                            Image(systemName: "checkmark")
                                                .font(.caption2)
                                                .foregroundStyle(.secondary)
                                        }
                                        Text(episode.title)
                                            .lineLimit(2)
                                            .foregroundStyle(completed ? .secondary : .primary)
                                    }
                                    Text(completed ? "已听完 · \(clock(max(episode.durationSeconds, 0)))" : progressText(episode))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)

                            Menu {
                                Button("下一集播放") { enqueue(episode, next: true) }
                                Button(isQueued ? "从待播移除" : "加入待播") {
                                    if isQueued {
                                        playback.podcastCloud?.removeEpisode(episode.id)
                                    } else {
                                        enqueue(episode, next: false)
                                    }
                                }
                                Divider()
                                Button(completed ? "标为未听" : "标为已听完") {
                                    Task { await toggleCompleted(episode) }
                                }
                                Button(isFav ? "取消收藏" : "单集收藏") {
                                    Task { await toggleFavorite(episode) }
                                }
                            } label: {
                                Image(systemName: "ellipsis")
                                    .frame(width: 32, height: 32)
                            }
                            .accessibilityLabel("\(episode.title)的更多操作")
                        }
                    }
                }
            } else if message == nil {
                ProgressView()
            }
            if let notice {
                Text(notice).font(.caption).foregroundStyle(.secondary)
            }
            if let message {
                Text(message).font(.caption).foregroundStyle(.red)
            }
        }
        .navigationTitle(detail?.podcast.title ?? "节目")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await load()
            await playback.podcastCloud?.refreshPreferences()
        }
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
        guard episodes.contains(where: { $0.id == episode.id }) else { return }
        Haptics.tap()
        // 只把用户点的这一集插到云端待播队首，不把整份节目灌进去。
        applyContinuation(episodes, show: detail?.podcast)
        playback.playPodcastEpisode(episode.playbackItem, position: position)
    }

    private func applyContinuation(_ episodes: [PodcastEpisode], show: PodcastSummary?) {
        let refs: [PodcastContinuation.Episode] = episodes.enumerated().map { index, episode in
            PodcastContinuation.Episode(
                id: episode.id,
                title: episode.title,
                chronologicalIndex: episodes.count - 1 - index,
                isCompleted: episode.positionSeconds > 0 && episode.durationSeconds > 0
                    && episode.positionSeconds >= episode.durationSeconds
            )
        }
        let preference = playback.podcastCloud?.showPreference(show?.id ?? "").continuation
            ?? PodcastContinuation.Preference(autoContinue: playback.podcastAutoContinueEnabled)
        playback.configurePodcastContinuation(
            podcastID: show?.id,
            episodes: refs,
            preference: preference
        )
    }

    private func enqueue(_ episode: PodcastEpisode, next: Bool) {
        guard let cloud = playback.podcastCloud else {
            message = "暂时无法加入待播。请重新登录后再试。"
            return
        }
        let current = PlaybackService.podcastEpisodeID(playback.currentItem?.trackID ?? "")
        cloud.enqueueEpisode(episode.id, next: next, currentEpisodeID: current)
        notice = next ? "已加入待播 · 下一集播放" : "已加入待播"
    }

    private func isCompleted(_ episode: PodcastEpisode) -> Bool {
        episode.completed || (episode.positionSeconds > 0 && episode.durationSeconds > 0
            && episode.positionSeconds >= episode.durationSeconds)
    }

    private func isFavorite(_ episode: PodcastEpisode) -> Bool {
        favorites.isFavorite(episode.id) || episode.loved
    }

    private func filteredEpisodes(_ episodes: [PodcastEpisode]) -> [PodcastEpisode] {
        switch episodeFilter {
        case "unplayed":
            return episodes.filter { !isCompleted($0) }
        case "completed":
            return episodes.filter(isCompleted)
        case "favorite":
            return episodes.filter(isFavorite)
        default:
            return episodes
        }
    }

    private func toggleCompleted(_ episode: PodcastEpisode) async {
        let target = !isCompleted(episode)
        do {
            try await client.markPodcastEpisodeCompleted(episodeID: episode.id, duration: episode.durationSeconds, completed: target)
            await load()
        } catch {
            message = "标记完成失败：\(ErrorText.message(for: error))"
        }
    }

    private func toggleFavorite(_ episode: PodcastEpisode) async {
        await favorites.toggle(episode.id, isPodcast: true)
        await load()
    }

    private func playPendingQueue() {
        guard let first = playback.podcastCloud?.unifiedPendingEpisodes.first else { return }
        Task {
            if let item = await playback.podcastCloud?.playbackItem(for: first.episodeId) {
                playback.playPodcastEpisode(item)
            }
        }
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

private struct PodcastCloudStatusIOS: View {
    let cloud: PodcastCloudQueue

    var body: some View {
        if cloud.conflict != nil {
            VStack(alignment: .leading, spacing: 8) {
                Text(PodcastCloudQueue.conflictMessage)
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    Button("使用服务器上的队列") { cloud.adoptServerQueue() }
                    Button("用本机覆盖") { cloud.overwriteWithLocal() }
                }
            }
        } else if let syncError = cloud.syncError {
            VStack(alignment: .leading, spacing: 8) {
                Text(syncError)
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                Button("重试") { Task { await cloud.retrySync() } }
            }
        }
    }
}

private struct PodcastIntakeSettingsIOS: View {
    let playback: PlaybackService
    let podcastID: String
    var onSaved: () -> Void = {}

    @State private var action = "queue_last"
    @State private var order = "follow"
    @State private var ready = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("新集自动加入待播", selection: $action) {
                Text("不处理").tag("ignore")
                Text("加到队尾").tag("queue_last")
                Text("插到当前之后").tag("queue_next")
            }
            Picker("自动续播", selection: $order) {
                Text("跟随列表").tag("follow")
                Text("从旧到新").tag("asc")
                Text("从新到旧").tag("desc")
                Text("关闭").tag("off")
            }
            if let message = playback.podcastCloud?.preferenceError {
                Text(message).font(.footnote).foregroundStyle(.orange)
                Button("重试") { Task { await save() } }
            }
        }
        .task(id: podcastID) { await load() }
        .onChange(of: action) { _, _ in Task { await save() } }
        .onChange(of: order) { _, _ in Task { await save() } }
    }

    private func load() async {
        ready = false
        await playback.podcastCloud?.refreshPreferences()
        let show = playback.podcastCloud?.showPreference(podcastID)
        let rawAction = show?.action ?? "queue_last"
        action = (rawAction == "inbox" || rawAction.isEmpty) ? "queue_last" : rawAction
        order = (show?.autoContinue == false || show?.order == "off") ? "off" : (show?.order ?? "follow")
        ready = true
    }

    private func save() async {
        guard ready, let cloud = playback.podcastCloud else { return }
        if !cloud.hasResolvedPreferences {
            await cloud.refreshPreferences()
        }
        let current = cloud.showPreference(podcastID)
        let effective = (current.autoContinue == false || current.order == "off") ? "off" : current.order
        guard cloud.preferenceError != nil || current.action != action || effective != order else { return }
        await cloud.updateShow(podcastID: podcastID, action: action, autoLimit: current.autoLimit, order: order)
        onSaved()
    }
}

private struct PodcastUnifiedQueueView: View {
    let client: WildstringClient
    let playback: PlaybackService
    @State private var shows: [PodcastSummary] = []
    @State private var loadingShows = false

    var body: some View {
        let cloud = playback.podcastCloud
        List {
            if let cloud {
                if cloud.conflict != nil {
                    Section {
                        PodcastCloudStatusIOS(cloud: cloud)
                    }
                }

                Section("待播单集") {
                    let items = cloud.unifiedPendingEpisodes
                    if cloud.loading && items.isEmpty {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("正在同步待播列表…").foregroundStyle(.secondary)
                        }
                    } else if items.isEmpty {
                        ContentUnavailableView(
                            "待播列表是空的",
                            systemImage: "list.bullet",
                            description: Text("从节目挑几集加入，或在下方开启新集自动加入待播。")
                        )
                    } else {
                        HStack {
                            Text("\(items.count) 集待播")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button {
                                playFirst(cloud)
                            } label: {
                                Label("播放全部", systemImage: "play.fill")
                                    .font(.caption.weight(.semibold))
                            }
                        }
                        ForEach(items) { item in
                            HStack(spacing: 10) {
                                Button {
                                    play(item.episodeId, cloud: cloud)
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.episode?.title ?? cloud.title(for: item.episodeId))
                                            .lineLimit(2)
                                            .foregroundStyle(Color.primary)
                                        if item.source == .inbox {
                                            Text("稍后听")
                                                .font(.caption2)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.plain)

                                Button {
                                    cloud.removeEpisode(item.episodeId)
                                } label: {
                                    Image(systemName: "trash")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("移除")
                            }
                        }
                    }
                }

                Section("新集自动加入待播") {
                    if loadingShows && shows.isEmpty {
                        ProgressView()
                    } else if shows.isEmpty {
                        Text("暂无已关注节目").foregroundStyle(.secondary)
                    } else {
                        ForEach(shows) { show in
                            PodcastDeliveryIOSRow(cloud: cloud, show: show)
                        }
                    }
                }
            } else {
                Text("暂时读不到待播列表。请重新登录后再试。").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("待播列表")
        .task {
            await playback.podcastCloud?.refreshInbox()
            await playback.podcastCloud?.refreshQueue()
            await playback.podcastCloud?.refreshPreferences()
            loadingShows = true
            do {
                shows = try await client.podcasts(followed: true)
            } catch {
                // Ignore failure
            }
            loadingShows = false
        }
    }

    private func play(_ episodeID: String, cloud: PodcastCloudQueue) {
        Task {
            if let item = await cloud.playbackItem(for: episodeID) {
                playback.playPodcastEpisode(item)
            }
        }
    }

    private func playFirst(_ cloud: PodcastCloudQueue) {
        guard let first = cloud.unifiedPendingEpisodes.first else { return }
        play(first.episodeId, cloud: cloud)
    }
}

private struct PodcastDeliveryIOSRow: View {
    let cloud: PodcastCloudQueue
    let show: PodcastSummary

    var body: some View {
        let pref = cloud.showPreference(show.id)
        let currentAction = (pref.action == "inbox" || pref.action.isEmpty) ? "queue_last" : pref.action
        HStack {
            Text(show.title)
                .lineLimit(1)
                .font(.subheadline)
            Spacer()
            Picker("处理方式", selection: Binding(
                get: { currentAction },
                set: { newAction in
                    Task {
                        await cloud.updateShow(
                            podcastID: show.id,
                            action: newAction,
                            autoLimit: pref.autoLimit,
                            order: pref.order
                        )
                    }
                }
            )) {
                Text("不处理").tag("ignore")
                Text("加到队尾").tag("queue_last")
                Text("插到当前之后").tag("queue_next")
            }
            .labelsHidden()
            .pickerStyle(.menu)
        }
    }
}
