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
    @Environment(\.dismiss) private var dismiss
    @State private var tracks: [Track] = []
    @State private var loading = true
    @State private var error: String?

    private var coverTrackID: String? {
        tracks.first(where: \.hasCover)?.id ?? tracks.first?.id
    }

    var body: some View {
        VStack(spacing: 0) {
            MacCollectionHeading(
                title: destination.title,
                subtitle: L10n("macTrackNav.trackCount", tracks.count),
                symbol: symbol,
                canPlay: !tracks.isEmpty,
                coverTrackID: coverTrackID,
                client: client,
                onBack: { dismiss() }
            ) {
                if let first = tracks.first(where: \.isAvailable) ?? tracks.first {
                    MacPlayback.play(tracks, startingAt: first, playback: playback)
                }
            }
            MacPlayableTracks(
                client: client,
                playback: playback,
                favorites: favorites,
                tracks: tracks,
                emptyTitle: error == nil ? L10n("macTrackNav.emptyTitle") : L10n("macTrackNav.errorTitle"),
                emptyDetail: error,
                canManage: canManage,
                isLoading: loading
            )
        }
        .navigationTitle(destination.title)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.backward")
                }
                .help(L10n("macTrackNav.back"))
                .keyboardShortcut("[", modifiers: .command)
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
                            error = L10n("macTrackNav.artistNotFound", name)
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
