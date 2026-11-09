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
                        entry(L10n("macHome.dailyRecommendations"), detail: recommendationDetail, symbol: "sparkles", tint: MacTheme.accent) {
                            session.page = .discover
                        }
                        entry(L10n("macHome.continueListening"), detail: playback.currentItem?.title ?? model.recent.first?.title ?? L10n("macHome.continueListeningFallback"),
                            symbol: "play.circle.fill", tint: .green) {
                            if playback.currentItem != nil {
                                playback.resume()
                            } else if let first = model.recent.first(where: \.isAvailable) ?? model.recent.first {
                                MacPlayback.play(model.recent, startingAt: first, playback: playback)
                            } else {
                                session.page = .listening
                            }
                        }
                        entry(L10n("macHome.podcasts"), detail: L10n("macHome.podcastsDetail"), symbol: "antenna.radiowaves.left.and.right", tint: .blue) {
                            session.page = .podcasts
                        }
                    }

                    if let error = model.error {
                        HStack {
                            Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.secondary)
                            Spacer()
                            Button(L10n("macHome.retry")) { Task { await model.load() } }.disabled(model.loading)
                        }.font(.callout)
                    }

                    VStack(alignment: .leading, spacing: 14) {
                        heading(L10n("macHome.recentlyAddedAlbums"), more: L10n("macHome.viewAlbums")) { session.page = .albums }
                        if model.albums.isEmpty {
                            empty(model.loading ? L10n("macHome.loadingLibrary") : L10n("macHome.noRecentAlbums"))
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
                                        }.buttonStyle(.plain).help(L10n("macHome.openAlbum", album.title))
                                    }
                                }.padding(.bottom, 6)
                            }
                        }
                    }

                    LazyVGrid(
                        columns: Array(repeating: GridItem(.flexible(), spacing: 28, alignment: .top), count: geometry.size.width >= 680 ? 2 : 1),
                        alignment: .leading, spacing: 28
                    ) {
                        tracksSection(L10n("macHome.recentlyAddedTracks"), tracks: model.added, more: L10n("macHome.browseTracks"), empty: L10n("macHome.noRecentTracks")) {
                            session.page = .tracks
                        }
                        tracksSection(L10n("macHome.recentlyPlayed"), tracks: model.recent, more: L10n("macHome.listeningHistory"), empty: L10n("macHome.noRecentHistory")) {
                            session.page = .listening
                        }
                    }
                }
                .padding(28)
                .frame(maxWidth: 1400, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .navigationTitle(L10n("macHome.title"))
        .task { await model.load() }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n("macHome.welcomeHeader"))
                .font(MacTheme.display(32))
                .foregroundStyle(MacTheme.ink)
            Text(L10n("macHome.welcomeSubtitle"))
                .font(MacTheme.caption)
                .foregroundStyle(MacTheme.muted)
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            Button {
                session.page = .assistant
            } label: {
                Label(L10n("macHome.musicAssistant"), systemImage: "bubble.left.and.bubble.right")
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .macPanel(padding: 0, radius: 10)
            }
            .help(L10n("macHome.openMusicAssistant"))

            Button {
                Task { await model.load() }
            } label: {
                Label(L10n("macHome.refreshHome"), systemImage: "arrow.clockwise")
                    .labelStyle(.iconOnly)
                    .frame(width: 34, height: 34)
                    .macPanel(padding: 0, radius: 10)
            }
            .disabled(model.loading)
            .help(model.loading ? L10n("macHome.refreshingHome") : L10n("macHome.refreshHome"))
        }
        .font(MacTheme.caption)
        .foregroundStyle(MacTheme.muted)
        .buttonStyle(.plain)
    }

    private var recommendationDetail: String {
        if let daily = model.daily, !daily.items.isEmpty { return L10n("macHome.dailyPickedCount", daily.items.count) }
        if model.recommendationError != nil { return L10n("macHome.dailyUnavailable") }
        return L10n("macHome.openDailyPlaylist")
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
            if tracks.isEmpty { empty(model.loading ? L10n("macHome.loading") : message) }
            ForEach(tracks) { track in
                Button { MacPlayback.play(tracks, startingAt: track, playback: playback) } label: {
                    HStack(spacing: 12) {
                        MacCover(client: client, trackID: track.hasCover ? track.id : (track.album != nil ? track.id : nil), side: 42)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(track.title)
                                .font(.system(size: 13, weight: playback.currentItem?.trackID == track.id ? .semibold : .regular))
                                .foregroundStyle(!track.isAvailable ? MacTheme.muted : playback.currentItem?.trackID == track.id ? MacTheme.accentDeep : MacTheme.ink)
                                .lineLimit(1)
                            if let reason = track.unavailableReason {
                                Label(reason, systemImage: "exclamationmark.circle").font(MacTheme.caption).foregroundStyle(MacTheme.muted)
                            }
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
                .accessibilityLabel(L10n("macHome.playTrack", track.title))
                .contextMenu {
                    Button(L10n("macHome.playNext"), systemImage: "text.line.first.and.arrowtriangle.forward") {
                        _ = playback.enqueue(items: [MacPlayback.item(track)], next: true)
                    }
                    Button(L10n("macHome.addToQueue"), systemImage: "text.badge.plus") {
                        _ = playback.enqueue(items: [MacPlayback.item(track)], next: false)
                    }
                    if let albumID = track.albumId {
                        Button(L10n("macHome.viewAlbum"), systemImage: "square.stack") {
                            navigate(.album(id: albumID, title: track.album ?? L10n("macHome.defaultAlbum")))
                        }
                    }
                }
            }
        }
    }
}
