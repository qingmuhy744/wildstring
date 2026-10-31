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
                Section("收听") {
                    if let summary {
                        LabeledContent("播放次数", value: "\(summary.playCount)")
                        LabeledContent("收听时长", value: durationText(summary.listenedMs))
                        LabeledContent("听过的歌", value: "\(summary.tracksPlayed)")
                        LabeledContent("收藏", value: "\(summary.favorites)")
                    } else if message == nil {
                        ProgressView()
                    }
                }
                Section {
                    Picker("范围", selection: $scope) {
                        Text("我的").tag("personal")
                        Text("大家").tag("community")
                    }
                    .pickerStyle(.segmented)
                    Picker("时间", selection: $period) {
                        Text("7 天").tag("7d")
                        Text("30 天").tag("30d")
                        Text("90 天").tag("90d")
                        Text("全部").tag("all")
                    }
                    if rankings.isEmpty {
                        Text("这段时间还没有收听记录。")
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
                    Text("收听排行")
                }
                Section("最近听过") {
                    if recent.isEmpty {
                        Text("听过的歌曲会出现在这里。")
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
                Section("每日推荐") {
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
            .navigationTitle("发现")
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
        if minutes < 60 { return "\(minutes) 分钟" }
        return "\(minutes / 60) 小时 \(minutes % 60) 分钟"
    }
}
