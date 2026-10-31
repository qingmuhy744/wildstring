import CoreNetwork
import CorePlayback
import SwiftUI

private struct MacTrackNavigationKey: EnvironmentKey {
    static let defaultValue: @MainActor @Sendable (MacTrackDestination) -> Void = { _ in }
}

extension EnvironmentValues {
    var navigateToTrackCollection: @MainActor @Sendable (MacTrackDestination) -> Void {
        get { self[MacTrackNavigationKey.self] }
        set { self[MacTrackNavigationKey.self] = newValue }
    }
}

enum MacTrackDestination: Hashable {
    case artist(name: String)
    case album(id: String, title: String)

    var title: String {
        switch self {
        case .artist(let name): name
        case .album(_, let title): title
        }
    }
}

struct MacTrackCollectionView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let favorites: MacFavorites?
    let destination: MacTrackDestination
    var canManage = false
    @State private var tracks: [Track] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        MacPlayableTracks(client: client, playback: playback, favorites: favorites, tracks: tracks,
            emptyTitle: error == nil ? "暂无歌曲" : "暂时无法打开", emptyDetail: error,
            canManage: canManage, isLoading: loading)
            .navigationTitle(destination.title)
            .safeAreaInset(edge: .top, spacing: 0) {
                MacCollectionHeading(title: destination.title, subtitle: "\(tracks.count) 首",
                    symbol: symbol, canPlay: !tracks.isEmpty) {
                    if let first = tracks.first { MacPlayback.play(tracks, startingAt: first, playback: playback) }
                }
            }
            .task(id: destination) {
                loading = true
                error = nil
                tracks = []
                defer { loading = false }
                do {
                    switch destination {
                    case .album(let id, _):
                        tracks = try await MacPages.albumTracks(client: client, albumId: id)
                    case .artist(let name):
                        let artists: [Artist] = try await MacPages.collect { offset in
                            try await client.artists(limit: 100, offset: offset, query: name)
                        }
                        if let artist = artists.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
                            tracks = try await MacPages.artistTracks(client: client, artistId: artist.id)
                        } else {
                            error = "未找到「\(name)」的艺人资料。"
                        }
                    }
                } catch {
                    self.error = MacErrorText.message(for: error)
                }
            }
    }

    private var symbol: String {
        switch destination {
        case .artist: "person.2"
        case .album: "square.stack"
        }
    }
}
