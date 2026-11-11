import CoreNetwork
import CorePlayback
import SwiftUI

extension PodcastEpisode {
    var playbackItem: PlaybackService.Item {
        let isDone = completed || (positionSeconds > 0 && durationSeconds > 0 && positionSeconds >= durationSeconds)
        return PlaybackService.Item(
            trackID: "podcast_ep_\(id)",
            title: title,
            artist: L10n("podcasts.defaultArtist"),
            album: nil,
            hasCover: false,
            streamPath: "api/v1/podcasts/episodes/\(id)/stream?proxy=1&cache=1",
            resumePositionSeconds: isDone ? 0 : Double(max(0, positionSeconds))
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
                        Label(L10n("podcasts.pendingQueue"), systemImage: "list.bullet")
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
                        Label(L10n("podcasts.playPendingQueueCount", pendingCount), systemImage: "play.fill")
                            .fontWeight(.semibold)
                    }
                }
                if let cloud = playback.podcastCloud {
                    PodcastCloudStatusIOS(cloud: cloud)
                }
                if shows.isEmpty, !isLoading {
                    ContentUnavailableView(
                        L10n("podcasts.emptyShowsTitle"),
                        systemImage: "antenna.radiowaves.left.and.right",
                        description: Text(L10n("podcasts.emptyShowsDescription"))
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
            .navigationTitle(L10n("podcasts.title"))
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    NavigationLink {
                        PodcastDiscoverView(client: client, playback: playback)
                    } label: {
                        Label(L10n("podcasts.discover"), systemImage: "safari")
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
        let author = show.author.isEmpty ? L10n("podcasts.defaultArtist") : show.author
        return show.unplayedEpisodes > 0
            ? L10n("podcasts.showSubtitleUnplayed", author, show.unplayedEpisodes)
            : L10n("podcasts.showSubtitleTotal", author, show.totalEpisodes)
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
                    Text(detail.podcast.description.isEmpty ? L10n("podcasts.noDescription") : detail.podcast.description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        Button(detail.podcast.followed ? L10n("podcasts.unfollow") : L10n("podcasts.follow")) {
                            Task { await toggleFollow(detail.podcast) }
                        }
                        let pendingQueueCount = playback.podcastCloud?.unifiedPendingEpisodes.count ?? 0
                        if pendingQueueCount > 0 {
                            Button {
                                playPendingQueue()
                            } label: {
                                Label(L10n("podcasts.playPendingQueueCount", pendingQueueCount), systemImage: "play.fill")
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
                    Picker(L10n("podcasts.episodeFilter"), selection: $episodeFilter) {
                        Text(L10n("podcasts.filterAll")).tag("all")
                        Text(L10n("podcasts.filterUnplayed")).tag("unplayed")
                        Text(L10n("podcasts.filterCompleted")).tag("completed")
                        Text(L10n("podcasts.filterFavorite")).tag("favorite")
                    }
                    .pickerStyle(.segmented)
                }
                Section(L10n("podcasts.episodesSection")) {
                    let displayedEpisodes = filteredEpisodes(detail.episodes)
                    if displayedEpisodes.isEmpty {
                        Text(L10n("podcasts.noMatchingEpisodes"))
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
                            .accessibilityLabel(isQueued ? L10n("podcasts.removeFromQueue") : L10n("podcasts.addToQueue"))

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
                                    Text(completed ? L10n("podcasts.completedDuration", clock(max(episode.durationSeconds, 0))) : progressText(episode))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)

                            Menu {
                                Button(L10n("podcasts.playNext")) { enqueue(episode, next: true) }
                                Button(isQueued ? L10n("podcasts.removeFromQueue") : L10n("podcasts.addToQueue")) {
                                    if isQueued {
                                        playback.podcastCloud?.removeEpisode(episode.id)
                                    } else {
                                        enqueue(episode, next: false)
                                    }
                                }
                                Divider()
                                Button(completed ? L10n("podcasts.markUnplayed") : L10n("podcasts.markCompleted")) {
                                    Task { await toggleCompleted(episode) }
                                }
                                Button(isFav ? L10n("podcasts.unfavoriteEpisode") : L10n("podcasts.favoriteEpisode")) {
                                    Task { await toggleFavorite(episode) }
                                }
                            } label: {
                                Image(systemName: "ellipsis")
                                    .frame(width: 32, height: 32)
                            }
                            .accessibilityLabel(L10n("podcasts.moreActionsForEpisode", episode.title))
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
        .navigationTitle(detail?.podcast.title ?? L10n("podcasts.defaultTitle"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await load()
            await playback.podcastCloud?.refreshPreferences()
        }
        .confirmationDialog(
            L10n("podcasts.resumeDialogTitle"),
            isPresented: Binding(
                get: { resumeEpisode != nil },
                set: { if !$0 { resumeEpisode = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n("podcasts.resume")) {
                if let episode = resumeEpisode, let detail {
                    start(episode, in: detail.episodes, at: Double(episode.positionSeconds))
                }
                resumeEpisode = nil
            }
            Button(L10n("podcasts.playFromBeginning")) {
                if let episode = resumeEpisode, let detail {
                    start(episode, in: detail.episodes, at: 0)
                }
                resumeEpisode = nil
            }
            Button(L10n("podcasts.cancel"), role: .cancel) { resumeEpisode = nil }
        }
    }

    private func progressText(_ episode: PodcastEpisode) -> String {
        let total = max(episode.durationSeconds, 0)
        let position = min(max(episode.positionSeconds, 0), total > 0 ? total : episode.positionSeconds)
        if position > 0, total > 0 {
            return L10n("podcasts.listenedProgress", clock(position), clock(total))
        }
        if total > 0 { return clock(total) }
        return L10n("podcasts.durationUnknown")
    }

    private func clock(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    private func choose(_ episode: PodcastEpisode, in episodes: [PodcastEpisode]) {
        let remaining = episode.durationSeconds - episode.positionSeconds
        if episode.positionSeconds > 15, episode.durationSeconds == 0 || remaining > 30 {
            resumeEpisode = episode
        } else {
            let startPos = isCompleted(episode) ? 0 : Double(max(0, episode.positionSeconds))
            start(episode, in: episodes, at: startPos)
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
            message = L10n("podcasts.enqueueFailedAuth")
            return
        }
        let current = PlaybackService.podcastEpisodeID(playback.currentItem?.trackID ?? "")
        cloud.enqueueEpisode(episode.id, next: next, currentEpisodeID: current)
        notice = next ? L10n("podcasts.enqueuedNext") : L10n("podcasts.enqueued")
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
            message = L10n("podcasts.markCompletedFailed", ErrorText.message(for: error))
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
                    Button(L10n("podcasts.useServerQueue")) { cloud.adoptServerQueue() }
                    Button(L10n("podcasts.overwriteWithLocal")) { cloud.overwriteWithLocal() }
                }
            }
        } else if let syncError = cloud.syncError {
            VStack(alignment: .leading, spacing: 8) {
                Text(syncError)
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                Button(L10n("podcasts.retry")) { Task { await cloud.retrySync() } }
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
            Picker(L10n("podcasts.intakeAction"), selection: $action) {
                Text(L10n("podcasts.actionIgnore")).tag("ignore")
                Text(L10n("podcasts.actionQueueLast")).tag("queue_last")
                Text(L10n("podcasts.actionQueueNext")).tag("queue_next")
            }
            Picker(L10n("podcasts.autoContinue"), selection: $order) {
                Text(L10n("podcasts.orderFollow")).tag("follow")
                Text(L10n("podcasts.orderAsc")).tag("asc")
                Text(L10n("podcasts.orderDesc")).tag("desc")
                Text(L10n("podcasts.orderOff")).tag("off")
            }
            if let message = playback.podcastCloud?.preferenceError {
                Text(message).font(.footnote).foregroundStyle(.orange)
                Button(L10n("podcasts.retry")) { Task { await save() } }
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
    @State private var tab: String = "episodes"
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

                Section {
                    Picker(L10n("podcasts.pendingQueue"), selection: $tab) {
                        Text("\(L10n("podcasts.pendingEpisodesSection")) (\(cloud.unifiedPendingEpisodes.count))").tag("episodes")
                        Text("\(L10n("podcasts.intakeSection")) (\(shows.count))").tag("rules")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))

                if tab == "episodes" {
                    Section(L10n("podcasts.pendingEpisodesSection")) {
                        let items = cloud.unifiedPendingEpisodes
                        if cloud.loading && items.isEmpty {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text(L10n("podcasts.syncingQueue")).foregroundStyle(.secondary)
                            }
                        } else if items.isEmpty {
                            ContentUnavailableView(
                                L10n("podcasts.emptyQueueTitle"),
                                systemImage: "list.bullet",
                                description: Text(L10n("podcasts.emptyQueueDescription"))
                            )
                        } else {
                            HStack {
                                Text(L10n("podcasts.pendingCount", items.count))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button {
                                    playFirst(cloud)
                                } label: {
                                    Label(L10n("podcasts.playAll"), systemImage: "play.fill")
                                        .font(.caption.weight(.semibold))
                                }
                            }
                            ForEach(items) { item in
                                HStack(spacing: 10) {
                                    // The handle stays visible so the list reads as reorderable without a gesture.
                                    Image(systemName: "line.3.horizontal")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                        .accessibilityHidden(true)
                                    Button {
                                        play(item.episodeId, cloud: cloud)
                                    } label: {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(item.episode?.title ?? cloud.title(for: item.episodeId))
                                                .lineLimit(2)
                                                .foregroundStyle(Color.primary)
                                            if item.source == .inbox {
                                                Text(L10n("podcasts.listenLater"))
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
                                    .accessibilityLabel(L10n("podcasts.remove"))
                                }
                                // Finger drag: drop a row on another to move it. The queue is rewritten once, on drop.
                                .draggable(item.episodeId)
                                .dropDestination(for: String.self) { dropped, _ in
                                    guard let sourceId = dropped.first,
                                          let from = items.firstIndex(where: { $0.episodeId == sourceId }),
                                          let to = items.firstIndex(where: { $0.episodeId == item.episodeId }),
                                          from != to else { return false }
                                    var ids = items.map(\.episodeId)
                                    ids.insert(ids.remove(at: from), at: to)
                                    Haptics.selection()
                                    cloud.reorderPending(ids)
                                    return true
                                }
                            }
                        }
                    }
                } else {
                    Section(L10n("podcasts.intakeSection")) {
                        if loadingShows && shows.isEmpty {
                            ProgressView()
                        } else if shows.isEmpty {
                            Text(L10n("podcasts.noFollowedShows")).foregroundStyle(.secondary)
                        } else {
                            let sortedShows = shows.sorted { a, b in
                                let actA = cloud.showPreference(a.id).action
                                let actB = cloud.showPreference(b.id).action
                                let activeA = !actA.isEmpty && actA != "ignore"
                                let activeB = !actB.isEmpty && actB != "ignore"
                                if activeA != activeB { return activeA }
                                return false
                            }
                            ForEach(sortedShows) { show in
                                PodcastDeliveryIOSRow(cloud: cloud, show: show)
                            }
                        }
                    }
                }
            } else {
                Text(L10n("podcasts.queueReadFailedAuth")).foregroundStyle(.secondary)
            }
        }
        .navigationTitle(L10n("podcasts.pendingQueue"))
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
            Picker(L10n("podcasts.deliveryAction"), selection: Binding(
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
                Text(L10n("podcasts.actionIgnore")).tag("ignore")
                Text(L10n("podcasts.actionQueueLast")).tag("queue_last")
                Text(L10n("podcasts.actionQueueNext")).tag("queue_next")
            }
            .labelsHidden()
            .pickerStyle(.menu)
        }
    }
}
