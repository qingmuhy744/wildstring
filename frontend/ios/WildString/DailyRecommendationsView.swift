import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct DailyRecommendationsView: View {
    let client: WildstringClient
    let playback: PlaybackService
    var embedded = false

    @State private var items: [RecommendationItem] = []
    @State private var isLoading = true
    @State private var isRefreshing = false
    @State private var errorMessage: String?
    @State private var degraded = false

    var body: some View {
        if embedded {
            embeddedContent
        } else {
            standalone
        }
    }

    private var embeddedContent: some View {
        Group {
            if degraded {
                Text(L10n("dailyRec.degradedNotice"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            recommendationRows
            if isLoading || isRefreshing {
                ProgressView()
            } else if items.isEmpty {
                Text(errorMessage ?? L10n("dailyRec.emptyMessage"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Button(L10n("dailyRec.refresh")) { Task { await refresh() } }
                .disabled(isRefreshing || isLoading)
        }
        .task { await load() }
    }

    private var standalone: some View {
        NavigationStack {
            List {
                if degraded {
                    Text(L10n("dailyRec.degradedNotice"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                recommendationRows
                if isLoading || isRefreshing {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .overlay {
                if isLoading, items.isEmpty {
                    ProgressView()
                } else if items.isEmpty, let errorMessage {
                    ContentUnavailableView(
                        L10n("dailyRec.loadFailed"),
                        systemImage: "sparkles",
                        description: Text(errorMessage)
                    )
                } else if items.isEmpty {
                    ContentUnavailableView(
                        L10n("dailyRec.emptyTitle"),
                        systemImage: "sparkles",
                        description: Text(L10n("dailyRec.emptyDescription"))
                    )
                }
            }
            .navigationTitle(L10n("dailyRec.title"))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await refresh() }
                    } label: {
                        if isRefreshing {
                            ProgressView()
                        } else {
                            Text(L10n("dailyRec.refresh"))
                        }
                    }
                    .disabled(isRefreshing || isLoading)
                }
            }
            .miniPlayer(playback, client: client)
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private var recommendationRows: some View {
        ForEach(items) { item in
            TrackActionRow(client: client, track: item.track) {
                Button {
                    play(item)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        TrackRow(
                            client: client,
                            track: item.track,
                            isCurrent: playback.currentItem?.trackID == item.track.id
                        )
                        if !item.reason.isEmpty {
                            Text(item.reason)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func play(_ item: RecommendationItem) {
        let items = self.items
        guard let index = items.firstIndex(where: { $0.track.id == item.track.id }) else { return }
        playback.play(items: items.map(\.track.playbackItem), startingAt: index)
    }

    private func load() async {
        isLoading = items.isEmpty
        defer { isLoading = false }
        do {
            let daily = try await client.dailyRecommendations()
            items = daily.items
            degraded = daily.degraded ?? false
            errorMessage = nil
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    private func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let daily = try await client.refreshDailyRecommendations()
            items = daily.items
            degraded = daily.degraded ?? false
            errorMessage = nil
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }
}
