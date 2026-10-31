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
                Text("部分来源暂不可用，展示本地推荐。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            recommendationRows
            if isLoading || isRefreshing {
                ProgressView()
            } else if items.isEmpty {
                Text(errorMessage ?? "今天没有推荐。多听一些再回来看看。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Button("换一批") { Task { await refresh() } }
                .disabled(isRefreshing || isLoading)
        }
        .task { await load() }
    }

    private var standalone: some View {
        NavigationStack {
            List {
                if degraded {
                    Text("部分来源暂不可用，展示本地推荐。")
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
                        "无法加载推荐",
                        systemImage: "sparkles",
                        description: Text(errorMessage)
                    )
                } else if items.isEmpty {
                    ContentUnavailableView(
                        "今天没有推荐",
                        systemImage: "sparkles",
                        description: Text("多听一些再回来看看。")
                    )
                }
            }
            .navigationTitle("每日推荐")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await refresh() }
                    } label: {
                        if isRefreshing {
                            ProgressView()
                        } else {
                            Text("换一批")
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
