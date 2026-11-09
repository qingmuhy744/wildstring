import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct DiscoverView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var summary: ListeningSummary?
    @State private var rankings: [RankingRow] = []
    @State private var recent: [Track] = []
    @State private var scope = "personal"
    @State private var period = "30d"
    @State private var message: String?

    var body: some View {
        NavigationStack {
            List {
                Section(L10n("discoverView.listeningSection")) {
                    if let summary {
                        LabeledContent(L10n("discoverView.playCount"), value: "\(summary.playCount)")
                        LabeledContent(L10n("discoverView.listeningTime"), value: durationText(summary.listenedMs))
                        LabeledContent(L10n("discoverView.tracksPlayed"), value: "\(summary.tracksPlayed)")
                        LabeledContent(L10n("discoverView.favorites"), value: "\(summary.favorites)")
                    } else if message == nil {
                        ProgressView()
                    }
                }
                Section {
                    Picker(L10n("discoverView.scope"), selection: $scope) {
                        Text(L10n("discoverView.scopePersonal")).tag("personal")
                        Text(L10n("discoverView.scopeCommunity")).tag("community")
                    }
                    .pickerStyle(.segmented)
                    Picker(L10n("discoverView.period"), selection: $period) {
                        Text(L10n("discoverView.period7d")).tag("7d")
                        Text(L10n("discoverView.period30d")).tag("30d")
                        Text(L10n("discoverView.period90d")).tag("90d")
                        Text(L10n("discoverView.periodAll")).tag("all")
                    }
                    if rankings.isEmpty {
                        Text(L10n("discoverView.emptyRankings"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(rankings) { row in
                            Button {
                                playTracks(rankings.map(\.track), startingAt: row.track, using: playback)
                            } label: {
                                HStack(alignment: .firstTextBaseline) {
                                    Text("\(row.rank)")
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                        .frame(width: 24, alignment: .trailing)
                                    TrackRow(
                                        client: client,
                                        track: row.track,
                                        isCurrent: playback.currentItem?.trackID == row.track.id
                                    )
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                } header: {
                    Text(L10n("discoverView.rankings"))
                }
                Section(L10n("discoverView.recentlyPlayed")) {
                    if recent.isEmpty {
                        Text(L10n("discoverView.emptyRecent"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(recent) { track in
                            Button {
                                playTracks(recent, startingAt: track, using: playback)
                            } label: {
                                TrackRow(
                                    client: client,
                                    track: track,
                                    isCurrent: playback.currentItem?.trackID == track.id
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                Section(L10n("discoverView.dailyRecommendations")) {
                    DailyRecommendationsView(client: client, playback: playback, embedded: true)
                }
                if let message {
                    Section {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(L10n("discoverView.title"))
            .miniPlayer(playback, client: client)
            .task { await load() }
            .refreshable { await load() }
            .onChange(of: scope) { _, _ in Task { await loadRankings() } }
            .onChange(of: period) { _, _ in Task { await loadRankings() } }
        }
    }

    private func load() async {
        async let summaryCall: Void = loadSummary()
        async let rankingCall: Void = loadRankings()
        async let recentCall: Void = loadRecent()
        _ = await (summaryCall, rankingCall, recentCall)
    }

    private func loadSummary() async {
        do {
            summary = try await client.listeningSummary()
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func loadRankings() async {
        do {
            let page = try await client.rankings(scope: scope, period: period, metric: "plays")
            rankings = page.items
        } catch {
            rankings = []
            message = ErrorText.message(for: error)
        }
    }

    private func loadRecent() async {
        do {
            let page = try await client.tracks(
                limit: 20,
                sort: .lastPlayed,
                order: .desc,
                playedOnly: true
            )
            recent = page.items
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func durationText(_ milliseconds: Int64) -> String {
        let minutes = max(0, milliseconds) / 60_000
        if minutes < 60 { return L10n("discoverView.minutes", Int(minutes)) }
        return L10n("discoverView.hoursMinutes", Int(minutes / 60), Int(minutes % 60))
    }
}
