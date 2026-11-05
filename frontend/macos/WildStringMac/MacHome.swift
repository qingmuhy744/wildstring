import CoreNetwork
import CorePlayback
import Observation
import SwiftUI

@MainActor @Observable
final class MacHomeModel {
    private let client: WildstringClient
    private(set) var albums: [Album] = []
    private(set) var added: [Track] = []
    private(set) var recent: [Track] = []
    private(set) var daily: DailyRecommendations?
    private(set) var loading = true
    private(set) var error: String?
    private(set) var recommendationError: String?

    init(client: WildstringClient) { self.client = client }

    func load() async {
        loading = true
        defer { loading = false }
        async let albumPage = client.albums(limit: 10, sort: .addedAt, order: .desc)
        async let addedPage = client.tracks(limit: 6, sort: .addedAt, order: .desc)
        async let recentPage = client.tracks(limit: 6, sort: .lastPlayed, order: .desc, playedOnly: true)
        do {
            let pages = try await (albumPage, addedPage, recentPage)
            guard !Task.isCancelled else { return }
            albums = pages.0.items
            added = pages.1.items
            recent = pages.2.items
            error = nil
        } catch is CancellationError { return }
        catch { self.error = MacErrorText.message(for: error) }
        do {
            daily = try await client.dailyRecommendations()
            recommendationError = nil
        } catch is CancellationError { return }
        catch { recommendationError = MacErrorText.message(for: error) }
    }
}

struct MacHomeView: View {
    let session: MacSession
    let client: WildstringClient
    let playback: PlaybackService
    @State private var model: MacHomeModel
    @Environment(\.navigateToTrackCollection) private var navigate

    init(session: MacSession, client: WildstringClient, playback: PlaybackService) {
        self.session = session
        self.client = client
        self.playback = playback
        _model = State(initialValue: MacHomeModel(client: client))
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 30) {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .center, spacing: 24) {
                            introduction
                            Spacer(minLength: 0)
                            actions
                        }
                        VStack(alignment: .leading, spacing: 16) {
                            introduction
                            actions
                        }
                    }

                    LazyVGrid(
                        columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: geometry.size.width >= 720 ? 3 : 1),
                        spacing: 14
                    ) {
                        entry("每日推荐", detail: recommendationDetail, symbol: "sparkles", tint: MacTheme.accent) {
                            session.page = .discover
                        }
                        entry("继续收听", detail: playback.currentItem?.title ?? model.recent.first?.title ?? "找回上次听过的音乐",
                            symbol: "play.circle.fill", tint: .green) {
                            if playback.currentItem != nil {
                                playback.resume()
                            } else if let first = model.recent.first {
                                MacPlayback.play(model.recent, startingAt: first, playback: playback)
                            } else {
                                session.page = .listening
                            }
                        }
                        entry("电台与播客", detail: "继续节目，或探索新的声音", symbol: "antenna.radiowaves.left.and.right", tint: .blue) {
                            session.page = .podcasts
                        }
                    }

                    if let error = model.error {
                        HStack {
                            Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.secondary)
                            Spacer()
                            Button("重试") { Task { await model.load() } }.disabled(model.loading)
                        }.font(.callout)
                    }

                    VStack(alignment: .leading, spacing: 14) {
                        heading("最近添加的专辑", more: "查看专辑") { session.page = .albums }
                        if model.albums.isEmpty {
                            empty(model.loading ? "正在读取曲库…" : "新加入曲库的专辑会显示在这里。")
                        } else {
                            ScrollView(.horizontal) {
                                HStack(alignment: .top, spacing: 18) {
                                    ForEach(model.albums) { album in
                                        Button {
                                            navigate(.album(id: album.id, title: album.title))
                                        } label: {
                                            VStack(alignment: .leading, spacing: 8) {
                                                MacCover(client: client, trackID: album.coverTrackId, side: 144)
                                                Text(album.title)
                                                    .font(.system(size: 13, weight: .semibold))
                                                    .foregroundStyle(MacTheme.ink)
                                                    .lineLimit(1)
                                                Text(album.artists.joined(separator: " / "))
                                                    .font(MacTheme.caption)
                                                    .foregroundStyle(MacTheme.muted)
                                                    .lineLimit(1)
                                            }.frame(width: 144, alignment: .leading).contentShape(Rectangle())
                                        }.buttonStyle(.plain).help("打开专辑「\(album.title)」")
                                    }
                                }.padding(.bottom, 6)
                            }
                        }
                    }

                    LazyVGrid(
                        columns: Array(repeating: GridItem(.flexible(), spacing: 28, alignment: .top), count: geometry.size.width >= 680 ? 2 : 1),
                        alignment: .leading, spacing: 28
                    ) {
                        tracksSection("最近添加的歌曲", tracks: model.added, more: "浏览歌曲", empty: "新入库的歌曲会显示在这里。") {
                            session.page = .tracks
                        }
                        tracksSection("最近听过", tracks: model.recent, more: "收听记录", empty: "听几首喜欢的歌，记录会出现在这里。") {
                            session.page = .listening
                        }
                    }
                }
                .padding(28)
                .frame(maxWidth: 1400, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .navigationTitle("首页")
        .task { await model.load() }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("今天，想听点什么？")
                .font(MacTheme.display(32))
                .foregroundStyle(MacTheme.ink)
            Text("从熟悉的旋律，到刚加入收藏的新声音。")
                .font(MacTheme.caption)
                .foregroundStyle(MacTheme.muted)
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            Button {
                session.page = .assistant
            } label: {
                Label("音乐助手", systemImage: "bubble.left.and.bubble.right")
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .macPanel(padding: 0, radius: 10)
            }
            .help("打开音乐助手")

            Button {
                Task { await model.load() }
            } label: {
                Label("刷新首页", systemImage: "arrow.clockwise")
                    .labelStyle(.iconOnly)
                    .frame(width: 34, height: 34)
                    .macPanel(padding: 0, radius: 10)
            }
            .disabled(model.loading)
            .help(model.loading ? "正在刷新首页…" : "刷新首页")
        }
        .font(MacTheme.caption)
        .foregroundStyle(MacTheme.muted)
        .buttonStyle(.plain)
    }

    private var recommendationDetail: String {
        if let daily = model.daily, !daily.items.isEmpty { return "为你挑选了 \(daily.items.count) 首歌" }
        if model.recommendationError != nil { return "暂不可用 · 点击查看详情" }
        return "打开今天的专属歌单"
    }

    private func entry(_ title: String, detail: String, symbol: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 12) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(tint)
                    .frame(width: 36, height: 36)
                    .background(tint.opacity(0.12), in: Circle())
                Text(title).font(MacTheme.section(15)).foregroundStyle(MacTheme.ink)
                Text(detail).font(MacTheme.caption).foregroundStyle(MacTheme.muted).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .macPanel(padding: 18, radius: MacTheme.panelRadius)
            .contentShape(RoundedRectangle(cornerRadius: MacTheme.panelRadius))
        }.buttonStyle(.plain)
    }

    private func heading(_ title: String, more: String, action: @escaping () -> Void) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(MacTheme.display(20)).foregroundStyle(MacTheme.ink)
            Spacer()
            Button(more, action: action)
                .buttonStyle(.link)
                .font(MacTheme.caption)
        }
    }

    private func empty(_ message: String) -> some View {
        Text(message).font(MacTheme.caption).foregroundStyle(MacTheme.muted)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 20)
    }

    private func tracksSection(_ title: String, tracks: [Track], more: String, empty message: String,
        action: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            heading(title, more: more, action: action)
            if tracks.isEmpty { empty(model.loading ? "正在读取…" : message) }
            ForEach(tracks) { track in
                Button { MacPlayback.play(tracks, startingAt: track, playback: playback) } label: {
                    HStack(spacing: 12) {
                        MacCover(client: client, trackID: track.hasCover ? track.id : nil, side: 42)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(track.title)
                                .font(.system(size: 13, weight: playback.currentItem?.trackID == track.id ? .semibold : .regular))
                                .foregroundStyle(playback.currentItem?.trackID == track.id ? MacTheme.accentDeep : MacTheme.ink)
                                .lineLimit(1)
                            Text(track.artists.joined(separator: " / "))
                                .font(MacTheme.caption)
                                .foregroundStyle(MacTheme.muted)
                                .lineLimit(1)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: playback.currentItem?.trackID == track.id && playback.isPlaying ? "speaker.wave.2.fill" : "play.circle")
                            .foregroundStyle(MacTheme.accentDeep)
                    }.padding(.vertical, 6).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("播放 \(track.title)")
                .contextMenu {
                    Button("下一首播放", systemImage: "text.line.first.and.arrowtriangle.forward") {
                        _ = playback.enqueue(items: [MacPlayback.item(track)], next: true)
                    }
                    Button("加入播放队列", systemImage: "text.badge.plus") {
                        _ = playback.enqueue(items: [MacPlayback.item(track)], next: false)
                    }
                    if let albumID = track.albumId {
                        Button("查看专辑", systemImage: "square.stack") {
                            navigate(.album(id: albumID, title: track.album ?? "专辑"))
                        }
                    }
                }
            }
        }
    }
}
