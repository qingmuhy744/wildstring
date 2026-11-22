import CoreNetwork
import CorePlayback
import SwiftUI

struct PodcastPublishersView: View {
    let client: WildstringClient
    let playback: PlaybackService
    @State private var publishers: [PodcastPublisher]?
    @State private var error: String?

    var body: some View {
        List {
            ForEach(publishers ?? []) { publisher in
                NavigationLink(publisher.name) {
                    PodcastPublisherShowsView(client: client, playback: playback, publisher: publisher)
                }
            }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await load() } }
            } else if publishers == nil {
                ProgressView()
            } else if publishers?.isEmpty == true {
                ContentUnavailableView(L10n("consumer.noPublishers"), systemImage: "building.2")
            }
        }
        .navigationTitle(L10n("consumer.publishers"))
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            let loaded = try await client.podcastPublishers()
            guard !Task.isCancelled else { return }
            publishers = loaded
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}

struct PodcastPublisherShowsView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let publisher: PodcastPublisher
    @State private var shows: [PodcastSummary]?
    @State private var error: String?

    var body: some View {
        List {
            ForEach(shows ?? []) { show in
                NavigationLink(show.title) {
                    PodcastDetailView(client: client, playback: playback, podcastID: show.id)
                }
            }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await load() } }
            } else if shows == nil {
                ProgressView()
            } else if shows?.isEmpty == true {
                ContentUnavailableView(L10n("podcasts.emptyShowsTitle"), systemImage: "antenna.radiowaves.left.and.right")
            }
        }
        .navigationTitle(publisher.name)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            let loaded = try await client.podcastPublisher(id: publisher.id).podcasts
            guard !Task.isCancelled else { return }
            shows = loaded
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}

struct PodcastFavoritesView: View {
    let client: WildstringClient
    let playback: PlaybackService
    @Environment(FavoritesModel.self) private var favorites
    @State private var episodes: [PodcastFavoriteEpisode]?
    @State private var error: String?

    var body: some View {
        List {
            ForEach(episodes ?? []) { item in
                HStack(spacing: 8) {
                    Button {
                        playback.configurePodcastContinuation(
                            podcastID: item.episode.podcastId, episodes: [],
                            preference: playback.podcastCloud?.showPreference(item.episode.podcastId).continuation
                                ?? PodcastContinuation.Preference(autoContinue: playback.podcastAutoContinueEnabled)
                        )
                        playback.playPodcastEpisode(item.episode.playbackItem)
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.episode.title)
                            Text(item.podcastTitle).font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Menu {
                        NavigationLink(L10n("consumer.openShow")) {
                            PodcastDetailView(client: client, playback: playback, podcastID: item.episode.podcastId)
                        }
                        PodcastDownloadActions(client: client, episode: item.episode, podcastTitle: item.podcastTitle) {
                            await load()
                        } failed: { error = $0 }
                        Button(L10n("podcasts.unfavoriteEpisode")) {
                            Task { await unfavorite(item.id) }
                        }
                    } label: {
                        Image(systemName: "ellipsis").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel(L10n("podcasts.moreActionsForEpisode", item.episode.title))
                }
            }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await load() } }
            } else if episodes == nil {
                ProgressView()
            } else if episodes?.isEmpty == true {
                ContentUnavailableView(L10n("consumer.noFavoriteEpisodes"), systemImage: "heart")
            }
        }
        .navigationTitle(L10n("consumer.favoriteEpisodes"))
        .miniPlayer(playback, client: client)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            let loaded = try await client.podcastFavorites()
            guard !Task.isCancelled else { return }
            episodes = loaded
            error = nil
        } catch {
            if !Task.isCancelled { self.error = ErrorText.message(for: error) }
        }
    }

    private func unfavorite(_ id: String) async {
        do {
            try await client.favoritePodcastEpisode(episodeID: id, loved: false)
            await favorites.refresh()
            await load()
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}

struct PodcastDownloadActions: View {
    let client: WildstringClient
    let episode: PodcastEpisode
    let podcastTitle: String
    let reload: () async -> Void
    let failed: (String) -> Void
    @Environment(OfflineModel.self) private var offline

    var body: some View {
        let id = episode.playbackItem.trackID
        let download = offline.items.first { $0.trackID == id }
        Button(episode.resourceSaved ? L10n("consumer.releaseEpisode") : L10n("consumer.saveEpisode")) {
            Task {
                do {
                    try await client.setPodcastEpisodeSaved(id: episode.id, saved: !episode.resourceSaved)
                    await reload()
                } catch { failed(ErrorText.message(for: error)) }
            }
        }
        if download?.isCompleted == true {
            Button(L10n("trackAction.removeDownload"), role: .destructive) {
                Task { await offline.remove(trackID: id) }
            }
        } else {
            Button(L10n("consumer.downloadDevice")) {
                Task {
                    do {
                        try await offline.download(episode: episode, podcastTitle: podcastTitle)
                    } catch { failed(ErrorText.message(for: error)) }
                }
            }
            .disabled(download?.isDownloading == true)
        }
    }
}

struct PodcastDownloadPolicyView: View {
    let client: WildstringClient
    let podcastID: String
    @State private var settings: PodcastPersonalDownloadSettings?
    @State private var policy = "none"
    @State private var retention = "keep"
    @State private var busy = false
    @State private var error: String?
    @State private var saved = false

    var body: some View {
        Form {
            if settings != nil {
                Picker(L10n("consumer.autoDownload"), selection: $policy) {
                    Text(L10n("consumer.none")).tag("none")
                    ForEach([3, 5, 10], id: \.self) { count in
                        Text(L10n("consumer.latestEpisodes", count)).tag("latest_\(count)")
                    }
                    Text(L10n("podcasts.filterUnplayed")).tag("unplayed")
                    Text(L10n("podcasts.filterAll")).tag("all")
                }
                Picker(L10n("consumer.retention"), selection: $retention) {
                    Text(L10n("consumer.keep")).tag("keep")
                    Text(L10n("consumer.afterListening")).tag("delete_after_played")
                }
                Button(L10n("adminEdit.save")) { Task { await save() } }
                    .disabled(busy || (policy == settings?.downloadPolicy && retention == settings?.retentionPolicy))
                if saved { Text(L10n("adminEdit.savedMessage")).foregroundStyle(.secondary) }
            } else if error == nil { ProgressView() }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await load() } }
            }
        }
        .navigationTitle(L10n("consumer.autoDownload"))
        .task { await load() }
        .disabled(busy)
    }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            let current = try await client.podcastDownloadSettings(id: podcastID)
            if settings == nil {
                policy = current.downloadPolicy
                retention = current.retentionPolicy
            }
            settings = current
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func save() async {
        guard var settings else { return }
        busy = true
        defer { busy = false }
        settings.downloadPolicy = policy
        settings.retentionPolicy = retention
        do {
            self.settings = try await client.savePodcastDownloadSettings(id: podcastID, settings: settings)
            error = nil
            saved = true
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}

struct PodcastDownloadTasksView: View {
    let client: WildstringClient
    let playback: PlaybackService
    @Environment(\.canManageLibrary) private var canManage
    @State private var tasks: PodcastDownloadTasks?
    @State private var error: String?
    @State private var tab: Filter = .pending
    @State private var allTasks = false

    private enum Filter: String, CaseIterable {
        case pending, failed, complete
    }

    private var rows: [PodcastDownloadTask] {
        guard let tasks else { return [] }
        switch tab {
        case .pending: return tasks.downloading + tasks.queued
        case .failed: return tasks.failed
        case .complete: return tasks.recentCompleted
        }
    }

    var body: some View {
        List {
            if canManage {
                Picker(L10n("consumer.downloadScope"), selection: $allTasks) {
                    Text(L10n("consumer.downloadTasks")).tag(false)
                    Text(L10n("consumer.serverTasks")).tag(true)
                }
                .pickerStyle(.segmented)
            }
            Picker(L10n("consumer.downloadTasks"), selection: $tab) {
                ForEach(Filter.allCases, id: \.self) { filter in
                    Text(L10n("consumer.task.\(filter.rawValue)")).tag(filter)
                }
            }
            .pickerStyle(.segmented)
            ForEach(rows) { task in
                NavigationLink {
                    PodcastDetailView(client: client, playback: playback, podcastID: task.podcastID)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.title)
                        Text(task.podcastTitle).font(.caption).foregroundStyle(.secondary)
                        if let progress = task.progress, tab == .pending {
                            ProgressView(value: progress, total: 100)
                        }
                        if let error = task.error, tab == .failed {
                            Text(error).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .swipeActions {
                    if tab == .failed, !allTasks {
                        Button(L10n("consumer.retryAndSave")) { Task { await retry(task) } }
                            .tint(.wildAccentText)
                    }
                }
            }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await load() } }
            } else if tasks == nil {
                ProgressView()
            } else if rows.isEmpty {
                ContentUnavailableView(L10n("consumer.noTasks"), systemImage: "arrow.down.circle")
            }
            if canManage, allTasks, tab == .failed, !rows.isEmpty {
                Button(L10n("consumer.retryTasks")) {
                    Task {
                        do {
                            try await client.retryPodcastDownloadTasks()
                            await load()
                        } catch { self.error = ErrorText.message(for: error) }
                    }
                }
            }
        }
        .navigationTitle(L10n("consumer.downloadTasks"))
        .refreshable { await load() }
        .task(id: allTasks) {
            tasks = nil
            while !Task.isCancelled {
                await load()
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }

    private func retry(_ task: PodcastDownloadTask) async {
        do {
            try await client.setPodcastEpisodeSaved(id: task.episodeID, saved: true)
            await load()
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func load() async {
        do {
            let result = try await client.podcastDownloadTasks(all: canManage && allTasks)
            guard !Task.isCancelled else { return }
            tasks = result
            error = nil
        } catch {
            if !Task.isCancelled { self.error = ErrorText.message(for: error) }
        }
    }
}

struct PodcastPublisherEditor: View {
    let client: WildstringClient
    let show: PodcastSummary
    let saved: (PodcastDetail) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selectedID = ""
    @State private var name = ""
    @State private var publishers: [PodcastPublisher]?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let publishers {
                    Picker(L10n("consumer.publishers"), selection: $selectedID) {
                        Text(L10n("consumer.noPublisher")).tag("")
                        ForEach(publishers) { publisher in
                            Text(publisher.name).tag(publisher.id)
                        }
                    }
                    TextField(L10n("consumer.newPublisher"), text: $name)
                } else if error == nil {
                    ProgressView()
                }
                if let error {
                    Text(error).foregroundStyle(.secondary)
                    if publishers == nil {
                        Button(L10n("notifications.retry")) { Task { await load() } }
                    }
                }
            }
            .disabled(busy)
            .navigationTitle(L10n("consumer.editPublisher"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L10n("adminEdit.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n("adminEdit.save")) { Task { await save() } }
                        .disabled(busy || publishers == nil)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            publishers = try await client.podcastPublishers()
            selectedID = show.publisher?.id ?? ""
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        do {
            let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
            let updated = try await client.assignPodcastPublisher(
                show: show, publisherID: title.isEmpty && !selectedID.isEmpty ? selectedID : nil,
                name: title.isEmpty ? nil : title
            )
            saved(updated)
            dismiss()
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}
