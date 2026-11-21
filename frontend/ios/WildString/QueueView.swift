import CoreNetwork
import CorePlayback
import SwiftUI

/// Current playback queue with jump, drag reorder and swipe removal.
@MainActor
struct QueueView: View {
    let client: WildstringClient
    let playback: PlaybackService
    var onClose: (() -> Void)?

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
            ScrollViewReader { scroll in
                Group {
                    if isPodcast, let cloud = playback.podcastCloud {
                        podcastQueueList(cloud: cloud)
                    } else {
                        musicQueueList
                    }
                }
                .navigationTitle(isPodcast ? L10n("queueView.podcastQueue") : L10n("queueView.musicQueue"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            if let onClose { onClose() } else { dismiss() }
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .accessibilityLabel(L10n("queueView.close"))
                    }
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button {
                            guard let id = currentRowID else { return }
                            scroll.scrollTo(id, anchor: .center)
                        } label: {
                            Image(systemName: "scope")
                        }
                        .accessibilityLabel(L10n("queueView.locateCurrent"))
                        .disabled(currentRowID == nil)
                        EditButton()
                    }
                }
            }
        }
    }

    private var currentRowID: String? {
        if isPodcast, let cloud = playback.podcastCloud {
            return cloud.items.first(where: { $0.episodeId == currentEpisodeID })?.episodeId
        }
        guard let index = playback.currentIndex, playback.items.indices.contains(index) else { return nil }
        return playback.items[index].id.uuidString
    }

    private var musicQueueList: some View {
        List {
            if playback.heartContinuationEnabled {
                Text(L10n(playback.isHeartContinuation ? "playback.heartActive" : "playback.heartPending"))
                    .font(.caption).foregroundStyle(.secondary)
            }
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
                .id(item.id.uuidString)
                .accessibilityAddTraits(playback.currentIndex == index ? .isSelected : [])
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
            if cloud.conflict != nil || cloud.syncError != nil || cloud.queueFullNotice != nil {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        if cloud.conflict != nil {
                            Text(PodcastCloudQueue.conflictMessage)
                                .font(.footnote)
                                .foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                            VStack(alignment: .leading, spacing: 8) {
                                Button(L10n("queueView.adoptServerQueue")) { cloud.adoptServerQueue() }
                                Button(L10n("queueView.overwriteWithLocal")) { cloud.overwriteWithLocal() }
                                Button(L10n("queueView.keepLocalQueue")) { cloud.keepLocalWithoutOverwrite() }
                            }
                        } else if let syncError = cloud.syncError {
                            Text(syncError)
                                .font(.footnote)
                                .foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                            Button(L10n("queueView.retry")) { Task { await cloud.retrySync() } }
                        }
                        if let notice = cloud.queueFullNotice {
                            Text(notice)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
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
            Section(L10n("queueView.podcastQueue")) {
                if cloud.loading, cloud.items.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(L10n("queueView.syncingQueue")).foregroundStyle(.secondary)
                    }
                } else if cloud.items.isEmpty {
                    Text(playback.podcastAutoContinueEnabled ? L10n("queueView.autoContinueOn") : L10n("queueView.autoContinueOff"))
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
                                    Text(L10n("queueView.nowListening"))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .id(item.episodeId)
                        .accessibilityAddTraits(item.episodeId == currentEpisodeID ? .isSelected : [])
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
                            Button(L10n("queueView.addToQueue")) {
                                guard let episodeID = PlaybackService.podcastEpisodeID(item.trackID) else { return }
                                cloud.enqueueEpisode(episodeID, next: false, currentEpisodeID: currentEpisodeID)
                            }
                            .font(.caption)
                            .buttonStyle(.borderless)
                        }
                    }
                } header: {
                    Text(L10n("queueView.autoContinuation"))
                } footer: {
                    Text(L10n("queueView.autoContinuationHint"))
                }
            }
        }
        .task { await cloud.refreshQueue() }
    }

    private func playQueued(_ episodeID: String, cloud: PodcastCloudQueue) async {
        guard let item = await cloud.playbackItem(for: episodeID) else {
            actionError = L10n("queueView.cannotOpenEpisode")
            return
        }
        actionError = nil
        playback.playPodcastEpisode(item, line: .queue)
    }
}
