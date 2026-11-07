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
                NavigationLink {
                    PodcastInboxView(playback: playback)
                } label: {
                    Label("稍后听", systemImage: "tray")
                }
                if let cloud = playback.podcastCloud {
                    PodcastCloudStatusIOS(cloud: cloud)
                }
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
            .task(id: followedOnly) {
                await load()
                await playback.podcastCloud?.refreshPreferences()
            }
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
    @State private var notice: String?
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
                Section("单集") {
                    ForEach(detail.episodes) { episode in
                        HStack(spacing: 8) {
                            Button {
                                choose(episode, in: detail.episodes)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(episode.title).lineLimit(2)
                                    Text(progressText(episode))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            Menu {
                                Button("下一集播放") { enqueue(episode, next: true) }
                                Button("加入待播") { enqueue(episode, next: false) }
                                Button("加入稍后听") { Task { await saveForLater(episode) } }
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
        playback.configurePodcastContinuation(episodes: refs, preference: preference)
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

    private func saveForLater(_ episode: PodcastEpisode) async {
        guard let cloud = playback.podcastCloud else {
            message = "暂时无法加入稍后听。请重新登录后再试。"
            return
        }
        if let error = await cloud.addToInbox(episodeID: episode.id) {
            message = error
        } else {
            notice = "已加入稍后听"
            message = nil
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

    @State private var action = "inbox"
    @State private var autoLimit = 3
    @State private var order = "follow"
    @State private var ready = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("新集处理", selection: $action) {
                Text("稍后听").tag("inbox")
                Text("加到队尾").tag("queue_last")
                Text("插到当前之后").tag("queue_next")
                Text("不处理").tag("ignore")
            }
            Stepper(value: $autoLimit, in: 0...100) {
                Text("最多自动入队 \(autoLimit) 集").monospacedDigit()
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
        .onChange(of: autoLimit) { _, _ in Task { await save() } }
        .onChange(of: order) { _, _ in Task { await save() } }
    }

    private func load() async {
        ready = false
        await playback.podcastCloud?.refreshPreferences()
        let show = playback.podcastCloud?.showPreference(podcastID)
        action = show?.action ?? "inbox"
        autoLimit = show?.autoLimit ?? 3
        order = (show?.autoContinue == false || show?.order == "off") ? "off" : (show?.order ?? "follow")
        ready = true
    }

    private func save() async {
        guard ready, let cloud = playback.podcastCloud, cloud.preferences != nil else { return }
        let current = cloud.showPreference(podcastID)
        let effective = (current.autoContinue == false || current.order == "off") ? "off" : current.order
        guard current.action != action || current.autoLimit != autoLimit || effective != order else { return }
        await cloud.updateShow(podcastID: podcastID, action: action, autoLimit: autoLimit, order: order)
        onSaved()
    }
}

private struct PodcastInboxView: View {
    let playback: PlaybackService

    var body: some View {
        let cloud = playback.podcastCloud
        List {
            if let cloud {
                if cloud.inboxLoading, cloud.inbox.items.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("正在读取稍后听…").foregroundStyle(.secondary)
                    }
                } else if let inboxError = cloud.inboxError, cloud.inbox.items.isEmpty {
                    Text(inboxError).foregroundStyle(.secondary)
                    Button("重试") { Task { await cloud.refreshInbox() } }
                } else if cloud.inbox.items.isEmpty {
                    ContentUnavailableView(
                        "稍后听是空的",
                        systemImage: "tray",
                        description: Text("关注的节目更新后会出现在这里。返回节目列表可以浏览订阅。")
                    )
                } else {
                    if let inboxError = cloud.inboxError {
                        Text(inboxError).font(.footnote).foregroundStyle(.orange)
                        Button("重试") { Task { await cloud.refreshInbox() } }
                    }
                    ForEach(cloud.inbox.items) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(cloud.title(for: item.episodeId)).lineLimit(2)
                            HStack(spacing: 12) {
                                Button("加入待播") {
                                    cloud.enqueueEpisode(item.episodeId, next: false, currentEpisodeID: nil)
                                }
                                Button("移除") { Task { await cloud.removeFromInbox(episodeID: item.episodeId) } }
                            }
                            .font(.caption)
                        }
                    }
                }
            } else {
                Text("暂时读不到稍后听。请重新登录后再试。").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("稍后听")
        .task { await playback.podcastCloud?.refreshInbox() }
    }
}
