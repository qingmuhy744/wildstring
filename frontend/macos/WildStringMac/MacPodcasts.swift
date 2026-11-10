import CoreNetwork
import CorePlayback
import SwiftUI

struct MacPodcastsView: View {
    let client: WildstringClient
    let playback: PlaybackService
    var favorites: MacFavorites? = nil

    private var cloud: PodcastCloudQueue? { playback.podcastCloud }

    @State private var shows: [PodcastSummary] = []
    @State private var detail: PodcastDetail?
    @State private var resume: PodcastEpisode?
    @State private var message: String?
    @State private var detailMessage: String?
    @State private var selectedShowID: String?
    @State private var loadingShows = true
    @State private var loadingDetail = false
    @State private var choosingShow = false
    @State private var showQuery = ""
    @State private var descriptionExpanded = false
    @State private var exploring = false
    @State private var episodeFilter = "all"
    @State private var newestFirst = true
    @State private var showingInbox = false

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
                                Label(L10n("macPodcasts.selectShow"), systemImage: "list.bullet")
                            }
                            Spacer()
                            Text(L10n("macPodcasts.showCount", shows.count)).font(.caption).foregroundStyle(.secondary)
                        }.padding(14).background(.bar)
                    }
            }
        }
        .navigationTitle(L10n("macPodcasts.title"))
        .toolbar {
            ToolbarItemGroup {
                Button { exploring = true } label: { Label(L10n("macPodcasts.explore"), systemImage: "safari") }
                Button {
                    Task { await loadShows() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help(L10n("macPodcasts.refreshShows"))
                .disabled(loadingShows)
            }
        }
        .task {
            await loadShows()
            await playback.podcastCloud?.refreshPreferences()
        }
        .task(id: showingInbox) {
            if showingInbox { await playback.podcastCloud?.refreshInbox() }
        }
        .sheet(isPresented: $exploring) {
            MacPodcastExplore(client: client) { id in
                selectedShowID = id
                Task { await loadShows() }
            }
        }
        .sheet(isPresented: $choosingShow) {
            VStack(spacing: 0) {
                HStack { Spacer(); Button(L10n("macPodcasts.close")) { choosingShow = false } }
                    .padding(12)
                showList
            }.frame(width: 360, height: 520)
        }
        .confirmationDialog(L10n("macPodcasts.resumePrompt"), isPresented: Binding(
            get: { resume != nil },
            set: { if !$0 { resume = nil } }
        ), titleVisibility: .visible) {
            Button(L10n("macPodcasts.resume")) {
                if let episode = resume, let detail {
                    start(episode, in: detail.episodes, at: Double(episode.positionSeconds))
                }
                resume = nil
            }
            Button(L10n("macPodcasts.playFromStart")) {
                if let episode = resume, let detail {
                    start(episode, in: detail.episodes, at: 0)
                }
                resume = nil
            }
            Button(L10n("macPodcasts.cancel"), role: .cancel) { resume = nil }
        } message: {
            if let episode = resume {
                Text(L10n("macPodcasts.resumeProgress", macPodcastClock(episode.positionSeconds), macPodcastClock(episode.durationSeconds)))
            }
        }
    }

    private var showList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(L10n("macPodcasts.mySubscriptions"))
                    .font(MacTheme.micro)
                    .foregroundStyle(MacTheme.muted)
                Spacer()
                if loadingShows {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 10)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12))
                    .foregroundStyle(MacTheme.faint)
                TextField(L10n("macPodcasts.searchShows"), text: $showQuery)
                    .textFieldStyle(.plain)
                    .font(MacTheme.caption)
                    .foregroundStyle(MacTheme.ink)
                if !showQuery.isEmpty {
                    Button {
                        showQuery = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(MacTheme.faint)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(MacTheme.panel, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(MacTheme.border, lineWidth: 1)
            )
            .padding(.horizontal, 14)
            .padding(.bottom, 8)
            let pendingCount = cloud?.unifiedPendingEpisodes.count ?? 0
            Button {
                showingInbox = true
                choosingShow = false
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "list.bullet")
                        .foregroundStyle(showingInbox ? MacTheme.accentDeep : MacTheme.muted)
                    Text(L10n("macPodcasts.upNext"))
                        .font(.system(size: 13, weight: showingInbox ? .semibold : .medium))
                        .foregroundStyle(MacTheme.ink)
                    Spacer(minLength: 0)
                    if pendingCount > 0 {
                        Text("\(pendingCount)")
                            .font(MacTheme.mono(11))
                            .foregroundStyle(MacTheme.muted)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(showingInbox ? MacTheme.accent.opacity(0.14) : Color.clear)
                )
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10)
            .padding(.bottom, 8)

            if let message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }

            if shows.isEmpty, !loadingShows {
                ContentUnavailableView(
                    L10n("macPodcasts.noSubscriptions"),
                    systemImage: "antenna.radiowaves.left.and.right",
                    description: Text(L10n("macPodcasts.noSubscriptionsDesc"))
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
                                showingInbox = false
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
        .background(MacTheme.canvas)
    }

    @ViewBuilder
    private var detailPane: some View {
        if showingInbox {
            MacPodcastUnifiedQueue(client: client, playback: playback, shows: shows.filter { $0.followed }) {
                showingInbox = false
            }
        } else if loadingDetail {
            ProgressView(L10n("macPodcasts.openingShow"))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(MacTheme.canvas)
        } else if let detail {
            let completedCount = detail.episodes.filter(isCompleted).count
            let unplayedCount = max(0, detail.episodes.count - completedCount)
            let favoriteCount = detail.episodes.filter { isFavorite($0) }.count
            let visibleEpisodes = filteredEpisodes(from: detail.episodes)
            let groups = groupedEpisodes(from: visibleEpisodes)

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    podcastHeader(detail, unplayedCount: unplayedCount)
                    Rectangle().fill(MacTheme.border).frame(height: 1)
                    HStack(spacing: 12) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(L10n("macPodcasts.episodes"))
                                .font(MacTheme.section(15))
                                .foregroundStyle(MacTheme.ink)
                            Text("\(detail.episodes.count)")
                                .font(MacTheme.mono(12))
                                .foregroundStyle(MacTheme.muted)
                        }
                        HStack(spacing: 6) {
                            filterPill(L10n("macPodcasts.filterAll"), id: "all")
                            filterPill(L10n("macPodcasts.filterUnplayed", unplayedCount), id: "unplayed")
                            filterPill(L10n("macPodcasts.filterCompleted", completedCount), id: "completed")
                            filterPill(L10n("macPodcasts.filterFavorite", favoriteCount), id: "favorite")
                        }
                        .padding(.leading, 6)

                        Spacer()

                        Menu {
                            Button(L10n("macPodcasts.newestFirst")) { newestFirst = true }
                            Button(L10n("macPodcasts.oldestFirst")) { newestFirst = false }
                        } label: {
                            HStack(spacing: 4) {
                                Text(newestFirst ? L10n("macPodcasts.newestFirst") : L10n("macPodcasts.oldestFirst"))
                                Image(systemName: "chevron.down")
                                    .font(.system(size: 9, weight: .semibold))
                            }
                            .font(MacTheme.caption)
                            .foregroundStyle(MacTheme.muted)
                        }
                        .menuStyle(.borderlessButton)
                        .menuIndicator(.hidden)
                        .fixedSize()
                    }
                    if visibleEpisodes.isEmpty {
                        ContentUnavailableView(
                            episodeFilter == "completed" ? L10n("macPodcasts.noCompletedEpisodes") : (episodeFilter == "unplayed" ? L10n("macPodcasts.allEpisodesPlayed") : (episodeFilter == "favorite" ? L10n("macPodcasts.noFavoriteEpisodes") : L10n("macPodcasts.noEpisodes"))),
                            systemImage: episodeFilter == "favorite" ? "heart" : "waveform"
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 28)
                    } else {
                        LazyVStack(alignment: .leading, spacing: 6) {
                            ForEach(groups, id: \.title) { group in
                                if let title = group.title {
                                    Text(title)
                                        .font(MacTheme.micro)
                                        .foregroundStyle(MacTheme.muted)
                                        .padding(.top, 8)
                                        .padding(.bottom, 2)
                                        .padding(.horizontal, 4)
                                }
                                ForEach(group.episodes) { episode in
                                    MacPodcastEpisodeRow(
                                        episode: episode,
                                        showTitle: detail.podcast.title,
                                        current: playback.currentItem?.trackID == "podcast_ep_\(episode.id)",
                                        playing: playback.isPlaying,
                                        isQueued: cloud?.isQueued(episodeID: episode.id) ?? false,
                                        isFavorite: isFavorite(episode),
                                        action: {
                                            if playback.currentItem?.trackID == "podcast_ep_\(episode.id)" {
                                                playback.togglePlayPause()
                                            } else {
                                                choose(episode, in: detail.episodes)
                                            }
                                        },
                                        next: { enqueue(episode, in: detail.podcast, next: true) },
                                        append: { enqueue(episode, in: detail.podcast, next: false) },
                                        save: {},
                                        toggleQueue: {
                                            if let c = cloud {
                                                if c.isQueued(episodeID: episode.id) {
                                                    c.removeEpisode(episode.id)
                                                } else {
                                                    enqueue(episode, in: detail.podcast, next: false)
                                                }
                                            }
                                        },
                                        toggleCompleted: { Task { await toggleEpisodeCompleted(episode) } },
                                        toggleFavorite: { Task { await toggleEpisodeFavorite(episode) } }
                                    )
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: 860, alignment: .leading)
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .background(MacTheme.canvas)
        } else if let detailMessage {
            ContentUnavailableView(L10n("macPodcasts.cannotOpenShow"), systemImage: "wifi.exclamationmark",
                description: Text(detailMessage))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(MacTheme.canvas)
        } else {
            ContentUnavailableView(
                L10n("macPodcasts.selectAShow"),
                systemImage: "antenna.radiowaves.left.and.right",
                description: Text(L10n("macPodcasts.selectAShowDesc"))
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MacTheme.canvas)
        }
    }

    private func filterPill(_ title: String, id: String) -> some View {
        let active = episodeFilter == id
        return Button {
            episodeFilter = id
        } label: {
            Text(title)
                .font(.system(size: 11, weight: active ? .semibold : .regular))
                .foregroundStyle(active ? MacTheme.onAccent : MacTheme.muted)
                .padding(.horizontal, 11)
                .padding(.vertical, 4)
                .background(
                    active ? MacTheme.ink : MacTheme.panel,
                    in: Capsule()
                )
                .overlay(
                    Capsule()
                        .strokeBorder(active ? Color.clear : MacTheme.border, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    private func podcastHeader(_ detail: PodcastDetail, unplayedCount: Int) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 18) {
                MacPodcastArtwork(url: detail.podcast.coverURL, side: 92)
                VStack(alignment: .leading, spacing: 6) {
                    Text(detail.podcast.title)
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(MacTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(detail.podcast.author.isEmpty ? L10n("macPodcasts.defaultArtist") : detail.podcast.author)
                        .font(.callout)
                        .foregroundStyle(MacTheme.muted)
                    HStack(spacing: 0) {
                        Text(L10n("macPodcasts.totalEpisodesWithDot", detail.episodes.count))
                            .foregroundStyle(MacTheme.muted)
                        Text(unplayedCount > 0 ? L10n("macPodcasts.unplayedCount", unplayedCount) : L10n("macPodcasts.allCompleted"))
                            .foregroundStyle(unplayedCount > 0 ? MacTheme.accentDeep : MacTheme.muted)
                            .fontWeight(unplayedCount > 0 ? .medium : .regular)
                    }
                    .font(MacTheme.caption)

                    HStack(spacing: 10) {
                        if let next = detail.episodes.first(where: canResume) ?? detail.episodes.first(where: { !isCompleted($0) }) ?? detail.episodes.first {
                            Button { choose(next, in: detail.episodes) } label: {
                                Label(canResume(next) ? L10n("macPodcasts.resumeListening") : L10n("macPodcasts.playLatest"), systemImage: "play.fill")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(MacTheme.onAccent)
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 8)
                                    .background(MacTheme.accent, in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                        let pendingQueueCount = cloud?.unifiedPendingEpisodes.count ?? 0
                        if pendingQueueCount > 0 {
                            Button { playPendingQueue() } label: {
                                Label(L10n("macPodcasts.playPendingQueue", pendingQueueCount), systemImage: "play.fill")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(MacTheme.ink)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 8)
                                    .background(MacTheme.panel, in: Capsule())
                                    .overlay(Capsule().strokeBorder(MacTheme.border, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                        if detail.podcast.followed {
                            Menu {
                                Button {
                                    let shareText = [detail.podcast.title, detail.podcast.feedURL?.absoluteString]
                                        .compactMap { $0 }
                                        .joined(separator: "\n")
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(shareText, forType: .string)
                                    detailMessage = L10n("macPodcasts.shareCopied")
                                } label: {
                                    Label(L10n("macPodcasts.shareShow"), systemImage: "square.and.arrow.up")
                                }
                                Divider()
                                Button(role: .destructive) {
                                    Task { await toggle(detail.podcast) }
                                } label: {
                                    Label(L10n("macPodcasts.unsubscribe"), systemImage: "bell.slash")
                                }
                            } label: {
                                Image(systemName: "ellipsis")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(MacTheme.muted)
                                    .frame(width: 32, height: 32)
                                    .background(MacTheme.panel, in: Circle())
                                    .overlay(Circle().strokeBorder(MacTheme.border, lineWidth: 1))
                            }
                            .menuStyle(.borderlessButton)
                            .menuIndicator(.hidden)
                            .fixedSize()
                            .help(L10n("macPodcasts.moreShowActions"))
                            .accessibilityLabel(L10n("macPodcasts.moreShowActions"))
                        } else {
                            Button(L10n("macPodcasts.subscribe")) {
                                Task { await toggle(detail.podcast) }
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.top, 4)
                }
                Spacer(minLength: 0)
            }
            if !detail.podcast.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(detail.podcast.description)
                        .font(MacTheme.body)
                        .foregroundStyle(MacTheme.muted)
                        .lineSpacing(4)
                        .lineLimit(descriptionExpanded ? nil : 2)
                        .textSelection(.enabled)
                    Button(descriptionExpanded ? L10n("macPodcasts.collapseDescription") : L10n("macPodcasts.expandDescription")) { descriptionExpanded.toggle() }
                        .buttonStyle(.plain)
                        .font(MacTheme.caption.weight(.medium))
                        .foregroundStyle(MacTheme.accentDeep)
                }
            }
            PodcastIntakeSettings(playback: playback, podcastID: detail.podcast.id) {
                applyContinuation(detail.episodes, show: detail.podcast)
            }
            if let cloud = playback.podcastCloud {
                PodcastCloudStatus(cloud: cloud)
            }
            if let detailMessage {
                Text(detailMessage)
                    .font(.callout)
                    .foregroundStyle(MacTheme.accentDeep)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private struct EpisodeGroup {
        let title: String?
        let episodes: [PodcastEpisode]
    }

    private func isCompleted(_ episode: PodcastEpisode) -> Bool {
        episode.completed || (episode.positionSeconds > 0 && episode.durationSeconds > 0 &&
            episode.positionSeconds >= episode.durationSeconds)
    }

    private func isFavorite(_ episode: PodcastEpisode) -> Bool {
        if let fav = favorites {
            return fav.isFavorite(episode.id) || fav.isFavorite("podcast_ep_\(episode.id)")
        }
        return episode.loved
    }

    private func filteredEpisodes(from episodes: [PodcastEpisode]) -> [PodcastEpisode] {
        let filtered: [PodcastEpisode]
        switch episodeFilter {
        case "unplayed":
            filtered = episodes.filter { !isCompleted($0) }
        case "completed":
            filtered = episodes.filter(isCompleted)
        case "favorite":
            filtered = episodes.filter { isFavorite($0) }
        default:
            filtered = episodes
        }
        return newestFirst ? filtered : Array(filtered.reversed())
    }

    private func groupedEpisodes(from episodes: [PodcastEpisode]) -> [EpisodeGroup] {
        guard !episodes.isEmpty else { return [] }
        let cutoff = Date().addingTimeInterval(-7 * 86_400)
        var recent: [PodcastEpisode] = []
        var older: [PodcastEpisode] = []
        for episode in episodes {
            if let date = macPodcastParsedDate(episode.pubDate), date >= cutoff {
                recent.append(episode)
            } else {
                older.append(episode)
            }
        }
        if !recent.isEmpty && !older.isEmpty {
            return newestFirst
                ? [EpisodeGroup(title: L10n("macPodcasts.thisWeek"), episodes: recent), EpisodeGroup(title: L10n("macPodcasts.older"), episodes: older)]
                : [EpisodeGroup(title: L10n("macPodcasts.older"), episodes: older), EpisodeGroup(title: L10n("macPodcasts.thisWeek"), episodes: recent)]
        }
        if !recent.isEmpty {
            return [EpisodeGroup(title: L10n("macPodcasts.thisWeek"), episodes: recent)]
        }
        return [EpisodeGroup(title: nil, episodes: older)]
    }

    private func loadShows() async {
        loadingShows = true
        do {
            let loaded = try await client.podcasts(followed: true)
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
        guard episodes.contains(where: { $0.id == episode.id }) else { return }
        let show = detail?.podcast
        let artist = (show?.author.isEmpty == false) ? (show?.author ?? L10n("macPodcasts.defaultArtist")) : L10n("macPodcasts.defaultArtist")
        // 只把用户点的这一集插到云端待播队首，不把整份节目灌进去。
        applyContinuation(episodes, show: show)
        let item = PlaybackService.Item(
            trackID: "podcast_ep_\(episode.id)",
            title: episode.title,
            artist: artist,
            album: show?.title,
            streamPath: "api/v1/podcasts/episodes/\(episode.id)/stream?proxy=1&cache=1"
        )
        playback.playPodcastEpisode(item, position: position)
    }

    private func applyContinuation(_ episodes: [PodcastEpisode], show: PodcastSummary?) {
        let artist = (show?.author.isEmpty == false) ? (show?.author ?? L10n("macPodcasts.defaultArtist")) : L10n("macPodcasts.defaultArtist")
        let refs: [PodcastContinuation.Episode] = episodes.enumerated().map { index, episode in
            PodcastContinuation.Episode(
                id: episode.id,
                title: episode.title,
                artist: artist,
                album: show?.title,
                chronologicalIndex: episodes.count - 1 - index,
                isCompleted: isCompleted(episode)
            )
        }
        let preference = playback.podcastCloud?.showPreference(show?.id ?? "").continuation
            ?? PodcastContinuation.Preference(
                order: .follow,
                skipCompleted: true,
                autoContinue: playback.podcastAutoContinueEnabled
            )
        playback.configurePodcastContinuation(
            podcastID: show?.id,
            episodes: refs,
            preference: preference
        )
    }

    private func enqueue(_ episode: PodcastEpisode, in show: PodcastSummary, next: Bool) {
        let current = PlaybackService.podcastEpisodeID(playback.currentItem?.trackID ?? "")
        if let cloud = playback.podcastCloud {
            cloud.enqueueEpisode(episode.id, next: next, currentEpisodeID: current)
            detailMessage = next ? L10n("macPodcasts.enqueuedNext") : L10n("macPodcasts.enqueued")
            return
        }
        let item = PlaybackService.Item(
            trackID: "podcast_ep_\(episode.id)", title: episode.title,
            artist: show.author.isEmpty ? show.title : show.author, album: show.title,
            streamPath: "api/v1/podcasts/episodes/\(episode.id)/stream?proxy=1&cache=1")
        if playback.enqueue(items: [item], next: next) {
            detailMessage = next ? L10n("macPodcasts.enqueuedNext") : L10n("macPodcasts.enqueued")
        } else {
            detailMessage = playback.errorMessage
        }
    }

    private func saveForLater(_ episode: PodcastEpisode) async {
        guard let cloud = playback.podcastCloud else {
            detailMessage = L10n("macPodcasts.cannotAddToInbox")
            return
        }
        if let error = await cloud.addToInbox(episodeID: episode.id) {
            detailMessage = error
        } else {
            detailMessage = L10n("macPodcasts.addedToInbox")
        }
    }

    private func playPendingQueue() {
        guard let first = cloud?.unifiedPendingEpisodes.first else { return }
        Task {
            if let item = await cloud?.playbackItem(for: first.episodeId) {
                playback.playPodcastEpisode(item)
            }
        }
    }

    private func toggleEpisodeCompleted(_ episode: PodcastEpisode) async {
        let target = !isCompleted(episode)
        do {
            try await client.markPodcastEpisodeCompleted(episodeID: episode.id, duration: episode.durationSeconds, completed: target)
            await open(episode.podcastId)
        } catch {
            detailMessage = L10n("macPodcasts.markCompletedFailed", MacErrorText.message(for: error))
        }
    }

    private func toggleEpisodeFavorite(_ episode: PodcastEpisode) async {
        if let fav = favorites {
            await fav.toggle(episode.id, isPodcast: true)
            await open(episode.podcastId)
        } else {
            do {
                try await client.favoritePodcastEpisode(episodeID: episode.id, loved: !isFavorite(episode))
                await open(episode.podcastId)
            } catch {
                detailMessage = L10n("macPodcasts.favoriteFailed", MacErrorText.message(for: error))
            }
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
                        .font(.system(size: 13, weight: selected ? .semibold : .medium))
                        .foregroundStyle(MacTheme.ink)
                        .lineLimit(1)
                    Text(show.author.isEmpty ? L10n("macPodcasts.defaultArtist") : show.author)
                        .font(MacTheme.caption)
                        .foregroundStyle(MacTheme.muted)
                        .lineLimit(1)
                    Text(show.unplayedEpisodes > 0 ? L10n("macPodcasts.showEpisodesWithUnplayed", show.totalEpisodes, show.unplayedEpisodes) : L10n("macPodcasts.showEpisodesTotal", show.totalEpisodes))
                        .font(.system(size: 11))
                        .foregroundStyle(MacTheme.faint)
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
                    .fill(selected ? MacTheme.accent.opacity(0.14) : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct MacPodcastEpisodeRow: View {
    let episode: PodcastEpisode
    var showTitle: String? = nil
    var current: Bool = false
    var playing: Bool = false
    var isQueued: Bool = false
    var isFavorite: Bool = false
    var action: () -> Void = {}
    var next: () -> Void = {}
    var append: () -> Void = {}
    var save: () -> Void = {}
    var toggleQueue: (() -> Void)? = nil
    var toggleCompleted: (() -> Void)? = nil
    var toggleFavorite: (() -> Void)? = nil

    private var completed: Bool {
        episode.completed || (episode.positionSeconds > 0 && episode.durationSeconds > 0 &&
            episode.positionSeconds >= episode.durationSeconds)
    }

    private var inProgress: Bool {
        !completed && episode.positionSeconds > 0 && episode.durationSeconds > 0
    }

    private var displayTitle: String {
        cleanPodcastEpisodeTitle(episode.title, showTitle: showTitle)
    }

    var body: some View {
        HStack(spacing: 8) {
            Button(action: action) {
                HStack(spacing: 14) {
                    leadingControl
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(displayTitle)
                                .font(.system(size: 14, weight: current ? .semibold : (completed ? .regular : .medium)))
                                .foregroundStyle(current ? MacTheme.ink : (completed ? MacTheme.faint : MacTheme.ink))
                                .lineLimit(2)
                            if completed {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 13))
                                    .foregroundStyle(MacTheme.faint)
                                    .accessibilityLabel(L10n("macPodcasts.completed"))
                            }
                        }
                        metadataLine
                        if let progress = macPodcastProgress(episode), inProgress {
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    Capsule()
                                        .fill(MacTheme.border)
                                        .frame(height: 3.5)
                                    Capsule()
                                        .fill(MacTheme.accentDeep)
                                        .frame(width: max(6, geo.size.width * progress), height: 3.5)
                                }
                            }
                            .frame(height: 3.5)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)

            inlineQueueButton

            Menu {
                Button(L10n("macPodcasts.playNext"), action: next)
                Button(isQueued ? L10n("macPodcasts.removeFromQueue") : L10n("macPodcasts.addToQueue")) {
                    if let toggleQueue {
                        toggleQueue()
                    } else if !isQueued {
                        append()
                    }
                }
                if let toggleCompleted {
                    Button(completed ? L10n("macPodcasts.markAsUnplayed") : L10n("macPodcasts.markAsCompleted"), action: toggleCompleted)
                }
                if let toggleFavorite {
                    Button(isFavorite ? L10n("macPodcasts.unfavorite") : L10n("macPodcasts.favoriteEpisode"), action: toggleFavorite)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(completed && !current ? MacTheme.faint : MacTheme.muted)
                    .frame(width: 28, height: 30)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .padding(.trailing, 6)
            .accessibilityLabel(L10n("macPodcasts.moreActionsForEpisode", displayTitle))
        }
        .padding(.vertical, 2)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(current ? MacTheme.accent.opacity(0.14) : Color.clear)
        )
        .overlay(alignment: .bottom) {
            if !current {
                Rectangle()
                    .fill(MacTheme.border)
                    .frame(height: 1)
                    .padding(.leading, 60)
            }
        }
    }

    @ViewBuilder
    private var inlineQueueButton: some View {
        if current {
            Text(L10n("macPodcasts.nowPlaying"))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(MacTheme.accentDeep)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(MacTheme.accent.opacity(0.12), in: Capsule())
        } else if isQueued {
            Button {
                toggleQueue?()
            } label: {
                Text(L10n("macPodcasts.queuedBadge"))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(MacTheme.accentDeep)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(MacTheme.accent.opacity(0.12), in: Capsule())
            }
            .buttonStyle(.plain)
            .help(L10n("macPodcasts.removeFromQueueHelp"))
        } else {
            Button {
                if let toggleQueue {
                    toggleQueue()
                } else {
                    append()
                }
            } label: {
                Text(L10n("macPodcasts.addToQueueBadge"))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(MacTheme.muted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(MacTheme.panel, in: Capsule())
                    .overlay(Capsule().strokeBorder(MacTheme.border, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .help(L10n("macPodcasts.addToQueueHelp"))
        }
    }

    @ViewBuilder
    private var leadingControl: some View {
        if current {
            Image(systemName: playing ? "waveform" : "pause.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(MacTheme.accentDeep)
                .frame(width: 32, height: 32)
        } else {
            Circle()
                .fill(MacTheme.panel)
                .frame(width: 32, height: 32)
                .overlay(
                    Circle()
                        .strokeBorder(MacTheme.border, lineWidth: 1)
                )
                .overlay {
                    Image(systemName: "play.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(completed ? MacTheme.faint : MacTheme.ink)
                        .offset(x: 1)
                }
        }
    }

    private var metadataLine: some View {
        HStack(spacing: 4) {
            Text(macPodcastShortDate(episode.pubDate))
                .foregroundStyle(completed && !current ? MacTheme.faint : MacTheme.muted)
            if current {
                Text("· \(macPodcastDurationMinutes(episode.durationSeconds)) ·")
                    .foregroundStyle(MacTheme.muted)
                Text(playing ? L10n("macPodcasts.nowPlaying") : L10n("macPodcasts.paused"))
                    .foregroundStyle(MacTheme.accentDeep)
                    .fontWeight(.medium)
            } else if completed {
                Text(L10n("macPodcasts.durationWithCompleted", macPodcastDurationMinutes(episode.durationSeconds)))
                    .foregroundStyle(MacTheme.faint)
            } else if inProgress {
                let remainingMinutes = max(1, (episode.durationSeconds - episode.positionSeconds + 59) / 60)
                Text("·")
                    .foregroundStyle(MacTheme.muted)
                Text(L10n("macPodcasts.remainingMinutes", remainingMinutes))
                    .foregroundStyle(MacTheme.accentDeep)
                    .fontWeight(.medium)
            } else {
                Text("· \(macPodcastDurationMinutes(episode.durationSeconds))")
                    .foregroundStyle(MacTheme.muted)
            }
        }
        .font(MacTheme.caption.monospacedDigit())
        .lineLimit(1)
    }
}

func macPodcastClock(_ seconds: Int) -> String {
    let total = max(0, seconds)
    if total >= 3600 {
        return String(format: "%d:%02d:%02d", total / 3600, (total / 60) % 60, total % 60)
    }
    return String(format: "%d:%02d", total / 60, total % 60)
}

private func macPodcastDurationMinutes(_ seconds: Int) -> String {
    guard seconds > 0 else { return L10n("macPodcasts.durationUnknown") }
    let minutes = max(1, (seconds + 30) / 60)
    return L10n("macPodcasts.durationMinutes", minutes)
}

private func macPodcastProgress(_ episode: PodcastEpisode) -> Double? {
    guard episode.durationSeconds > 0, episode.positionSeconds > 0,
          episode.positionSeconds < episode.durationSeconds else { return nil }
    return min(1, Double(episode.positionSeconds) / Double(episode.durationSeconds))
}

func cleanPodcastEpisodeTitle(_ raw: String, showTitle: String? = nil) -> String {
    var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    text = text.replacingOccurrences(
        of: #"\s*(?:【[^】]{2,24}(?:播客|电台|Podcast)[^】]*】|\[[^\]]{2,24}(?:播客|电台|Podcast)[^\]]*\])\s*$"#,
        with: "",
        options: .regularExpression
    )
    if let showTitle = showTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !showTitle.isEmpty {
        for bracketed in ["【\(showTitle)】", "[\(showTitle)]", "｜\(showTitle)", " | \(showTitle)"] {
            if text.hasSuffix(bracketed) {
                text = String(text.dropLast(bracketed.count)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
    }
    return text.isEmpty ? raw : text
}

func macPodcastParsedDate(_ value: String) -> Date? {
    let iso = ISO8601DateFormatter()
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss Z"
    return iso.date(from: value) ?? formatter.date(from: value)
}

func macPodcastShortDate(_ value: String) -> String {
    guard let date = macPodcastParsedDate(value) else { return L10n("macPodcasts.dateNotProvided") }
    let calendar = Calendar.current
    if calendar.isDate(date, equalTo: Date(), toGranularity: .year) {
        let month = calendar.component(.month, from: date)
        let day = calendar.component(.day, from: date)
        return L10n("macPodcasts.monthDay", month, day)
    }
    return date.formatted(.dateTime.year().month(.defaultDigits).day(.defaultDigits))
}

func macPodcastDate(_ value: String) -> String {
    let date = macPodcastParsedDate(value)
    return date?.formatted(.dateTime.year().month(.twoDigits).day(.twoDigits)) ?? L10n("macPodcasts.dateNotProvided")
}

private struct PodcastIntakeSettings: View {
    let playback: PlaybackService
    let podcastID: String
    var onSaved: () -> Void = {}

    @State private var action = "queue_last"
    @State private var order = "follow"
    @State private var ready = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Text(L10n("macPodcasts.newEpisodeIntake"))
                    .font(MacTheme.caption)
                    .foregroundStyle(MacTheme.muted)
                Picker(L10n("macPodcasts.newEpisodeIntake"), selection: $action) {
                    Text(L10n("macPodcasts.intakeQueueLast")).tag("queue_last")
                    Text(L10n("macPodcasts.intakeQueueNext")).tag("queue_next")
                    Text(L10n("macPodcasts.intakeIgnore")).tag("ignore")
                }
                .pickerStyle(.menu)
                .fixedSize()
            }
            HStack(spacing: 12) {
                Text(L10n("macPodcasts.autoContinue"))
                    .font(MacTheme.caption)
                    .foregroundStyle(MacTheme.muted)
                Picker(L10n("macPodcasts.autoContinue"), selection: $order) {
                    Text(L10n("macPodcasts.continueFollow")).tag("follow")
                    Text(L10n("macPodcasts.continueAsc")).tag("asc")
                    Text(L10n("macPodcasts.continueDesc")).tag("desc")
                    Text(L10n("macPodcasts.continueOff")).tag("off")
                }
                .pickerStyle(.menu)
                .fixedSize()
            }
            if let message = playback.podcastCloud?.preferenceError {
                VStack(alignment: .leading, spacing: 6) {
                    Text(message).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    Button(L10n("macPodcasts.retry")) { Task { await save() } }.buttonStyle(.plain).font(.caption)
                }
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
        action = normalizeDeliveryAction(show?.action)
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

private struct MacPodcastUnifiedQueue: View {
    let client: WildstringClient
    let playback: PlaybackService
    let shows: [PodcastSummary]
    var browseShows: () -> Void

    var body: some View {
        let cloud = playback.podcastCloud
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text(L10n("macPodcasts.upNext"))
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(MacTheme.ink)

                if let cloud {
                    pendingEpisodesSection(cloud)

                    Rectangle().fill(MacTheme.border).frame(height: 1)

                    autoIntakeSection(cloud)
                } else {
                    Text(L10n("macPodcasts.cannotLoadQueue")).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(MacTheme.canvas)
    }

    private func pendingEpisodesSection(_ cloud: PodcastCloudQueue) -> some View {
        let items = cloud.unifiedPendingEpisodes
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 6) {
                    Text(L10n("macPodcasts.pendingEpisodes"))
                        .font(MacTheme.section(16))
                        .foregroundStyle(MacTheme.ink)
                    Text("\(items.count)")
                        .font(MacTheme.mono(12))
                        .foregroundStyle(MacTheme.muted)
                }
                Spacer()
                if !items.isEmpty {
                    Button {
                        playFirst(cloud)
                    } label: {
                        Label(L10n("macPodcasts.playAll"), systemImage: "play.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(MacTheme.onAccent)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(MacTheme.accent, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }

            if cloud.loading && items.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L10n("macPodcasts.syncingQueue")).foregroundStyle(.secondary)
                }
            } else if items.isEmpty {
                ContentUnavailableView(
                    L10n("macPodcasts.emptyQueue"),
                    systemImage: "list.bullet",
                    description: Text(L10n("macPodcasts.emptyQueueDesc"))
                )
                .padding(.vertical, 20)
            } else {
                VStack(spacing: 6) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        HStack(alignment: .center, spacing: 12) {
                            Button {
                                play(item.episodeId, cloud: cloud)
                            } label: {
                                Image(systemName: "play.fill")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(MacTheme.ink)
                                    .frame(width: 28, height: 28)
                                    .background(MacTheme.panel, in: Circle())
                                    .overlay(Circle().strokeBorder(MacTheme.border, lineWidth: 1))
                            }
                            .buttonStyle(.plain)

                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.episode?.title ?? cloud.title(for: item.episodeId))
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(MacTheme.ink)
                                    .lineLimit(2)
                                if item.origin == "rule" {
                                    Text(L10n("macPodcasts.autoAddedBadge"))
                                        .font(MacTheme.micro)
                                        .foregroundStyle(MacTheme.accentDeep)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)

                            VStack(spacing: 2) {
                                Button {
                                    reorder(items, from: index, to: index - 1, cloud: cloud)
                                } label: {
                                    Image(systemName: "chevron.up").font(.system(size: 9, weight: .semibold))
                                }
                                .buttonStyle(.plain)
                                .disabled(index == 0)
                                .help(L10n("macPodcasts.moveUp"))
                                Button {
                                    reorder(items, from: index, to: index + 1, cloud: cloud)
                                } label: {
                                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                                }
                                .buttonStyle(.plain)
                                .disabled(index == items.count - 1)
                                .help(L10n("macPodcasts.moveDown"))
                            }
                            .foregroundStyle(MacTheme.muted)

                            Button(L10n("macPodcasts.remove")) {
                                cloud.removeEpisode(item.episodeId)
                            }
                            .buttonStyle(.borderless)
                            .font(MacTheme.caption)
                            .foregroundStyle(MacTheme.muted)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(MacTheme.panel, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(MacTheme.border, lineWidth: 1))
                    }
                }
            }
        }
    }

    private func autoIntakeSection(_ cloud: PodcastCloudQueue) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n("macPodcasts.autoIntakeSectionTitle"))
                .font(MacTheme.section(16))
                .foregroundStyle(MacTheme.ink)

            if shows.isEmpty {
                Text(L10n("macPodcasts.autoIntakeEmptyShows"))
                    .font(MacTheme.caption)
                    .foregroundStyle(MacTheme.muted)
            } else {
                VStack(spacing: 8) {
                    ForEach(shows) { show in
                        MacShowDeliveryRow(cloud: cloud, show: show)
                    }
                }
            }
        }
    }

    private func play(_ episodeID: String, cloud: PodcastCloudQueue) {
        Task {
            if let item = await cloud.playbackItem(for: episodeID) {
                playback.playPodcastEpisode(item)
            }
        }
    }

    private func reorder(
        _ items: [PodcastCloudQueue.UnifiedPendingEpisode],
        from: Int,
        to: Int,
        cloud: PodcastCloudQueue
    ) {
        guard items.indices.contains(from), items.indices.contains(to) else { return }
        var ids = items.map(\.episodeId)
        ids.insert(ids.remove(at: from), at: to)
        cloud.reorderPending(ids)
    }

    private func playFirst(_ cloud: PodcastCloudQueue) {
        guard let first = cloud.unifiedPendingEpisodes.first else { return }
        play(first.episodeId, cloud: cloud)
    }
}

private struct MacShowDeliveryRow: View {
    let cloud: PodcastCloudQueue
    let show: PodcastSummary

    @State private var action: String = "queue_last"

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(show.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(MacTheme.ink)
                    .lineLimit(1)
                Text(show.author.isEmpty ? L10n("macPodcasts.defaultArtist") : show.author)
                    .font(MacTheme.caption)
                    .foregroundStyle(MacTheme.muted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Picker(L10n("macPodcasts.intakeRulePicker"), selection: $action) {
                Text(L10n("macPodcasts.intakeIgnore")).tag("ignore")
                Text(L10n("macPodcasts.intakeQueueLast")).tag("queue_last")
                Text(L10n("macPodcasts.intakeQueueNext")).tag("queue_next")
            }
            .pickerStyle(.menu)
            .fixedSize()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(MacTheme.panel, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(MacTheme.border, lineWidth: 1))
        .onAppear {
            let pref = cloud.showPreference(show.id)
            action = normalizeDeliveryAction(pref.action)
        }
        .onChange(of: action) { _, newAction in
            let pref = cloud.showPreference(show.id)
            Task {
                await cloud.updateShow(
                    podcastID: show.id,
                    action: newAction,
                    autoLimit: pref.autoLimit,
                    order: pref.order
                )
            }
        }
    }
}
