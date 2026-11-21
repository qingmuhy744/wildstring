import CoreNetwork
import CorePlayback
import SwiftUI

/// Shared playback, catalog and library actions for a track row.
struct TrackActionRow<Content: View>: View {
    let client: WildstringClient
    let playback: PlaybackService
    let track: Track
    @ViewBuilder let content: () -> Content

    @Environment(FavoritesModel.self) private var favorites
    @Environment(OfflineModel.self) private var offline
    @Environment(\.isAdmin) private var isAdmin
    @State private var destination: TrackCatalogDestination?
    @State private var queueError: String?
    @State private var addingToPlaylist = false
    @State private var editingMetadata = false
    @State private var editingLyrics = false
    @State private var editingSuggestions = false
    @State private var reviewingMetadata = false

    private var isDownloaded: Bool {
        offline.items.contains { $0.trackID == track.id && $0.isCompleted }
    }

    private var isDownloading: Bool {
        offline.items.contains { $0.trackID == track.id && $0.isDownloading }
    }

    var body: some View {
        content()
            .contextMenu {
                Button {
                    enqueue(next: true)
                } label: {
                    Label(L10n("trackAction.playNext"), systemImage: "text.insert")
                }
                .disabled(!track.isAvailable)
                Button {
                    enqueue(next: false)
                } label: {
                    Label(L10n("trackAction.appendToQueue"), systemImage: "text.append")
                }
                .disabled(!track.isAvailable)
                if let id = track.albumId {
                    Button {
                        destination = .album(id)
                    } label: {
                        Label(L10n("trackAction.openAlbum"), systemImage: "opticaldisc")
                    }
                }
                if let name = track.artists.first, track.artists.count == 1 {
                    Button {
                        destination = .artist(name)
                    } label: {
                        Label(L10n("trackAction.openArtist"), systemImage: "person")
                    }
                } else if !track.artists.isEmpty {
                    Menu(L10n("trackAction.openArtist"), systemImage: "person") {
                        ForEach(track.artists, id: \.self) { name in
                            Button(name) { destination = .artist(name) }
                        }
                    }
                }
                Divider()
                Button {
                    Haptics.selection()
                    Task { await favorites.toggle(track.id) }
                } label: {
                    Label(
                        favorites.isFavorite(track.id) ? L10n("trackAction.unfavorite") : L10n("trackAction.favorite"),
                        systemImage: favorites.isFavorite(track.id) ? "heart.slash" : "heart"
                    )
                }
                Button {
                    addingToPlaylist = true
                } label: {
                    Label(L10n("trackAction.addToPlaylist"), systemImage: "text.badge.plus")
                }
                if isDownloaded {
                    Button(role: .destructive) {
                        Task { await offline.remove(trackID: track.id) }
                    } label: {
                        Label(L10n("trackAction.removeDownload"), systemImage: "arrow.down.circle.slash")
                    }
                } else {
                    Button {
                        Task { await offline.download(track) }
                    } label: {
                        Label(L10n("trackAction.download"), systemImage: "arrow.down.circle")
                    }
                    .disabled(isDownloading)
                }
                if isAdmin {
                    Button {
                        editingMetadata = true
                    } label: {
                        Label(L10n("trackAction.editMetadata"), systemImage: "square.and.pencil")
                    }
                    Button {
                        editingLyrics = true
                    } label: {
                        Label(L10n("trackAction.editLyrics"), systemImage: "text.quote")
                    }
                    Button {
                        editingSuggestions = true
                    } label: {
                        Label(L10n("trackAction.updateSuggestions"), systemImage: "sparkles")
                    }
                    Button {
                        reviewingMetadata = true
                    } label: {
                        Label(L10n("trackAction.batchReview"), systemImage: "checklist")
                    }
                }
            }
            .sheet(item: $destination) {
                TrackCatalogSheet(client: client, playback: playback, destination: $0)
            }
            .alert(
                L10n("trackAction.queueFailed"),
                isPresented: Binding(get: { queueError != nil }, set: { if !$0 { queueError = nil } })
            ) {
                Button(L10n("queueView.close"), role: .cancel) {}
            } message: {
                Text(queueError ?? "")
            }
            .sheet(isPresented: $addingToPlaylist) {
                AddToPlaylistSheet(client: client, trackID: track.id)
            }
            .sheet(isPresented: $editingMetadata) {
                MetadataEditView(client: client, track: track)
            }
            .sheet(isPresented: $editingLyrics) {
                LyricsEditView(client: client, track: track)
            }
            .sheet(isPresented: $editingSuggestions) {
                MetadataSuggestionsView(client: client, track: track)
            }
            .sheet(isPresented: $reviewingMetadata) {
                MetadataReviewView(client: client, initialTrack: track)
            }
    }

    private func enqueue(next: Bool) {
        if playback.enqueue(items: [track.playbackItem], next: next) {
            Haptics.tap()
            AccessibilityNotification.Announcement(L10n("trackAction.queued")).post()
        } else {
            queueError = playback.errorMessage ?? L10n("trackAction.queueFailed")
        }
    }
}

private enum TrackCatalogDestination: Hashable, Identifiable {
    case album(String)
    case artist(String)

    var id: Self { self }
}

private struct TrackCatalogSheet: View {
    let client: WildstringClient
    let playback: PlaybackService
    let destination: TrackCatalogDestination

    @Environment(\.dismiss) private var dismiss
    @State private var album: Album?
    @State private var artist: Artist?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if let album {
                    AlbumDetailView(client: client, playback: playback, album: album)
                } else if let artist {
                    ArtistDetailView(client: client, playback: playback, artist: artist)
                } else if let errorMessage {
                    ContentUnavailableView {
                        Label(errorMessage, systemImage: "exclamationmark.circle")
                    } actions: {
                        Button(L10n("queueView.retry")) { Task { await load() } }
                    }
                } else {
                    ProgressView()
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(L10n("queueView.close")) { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        errorMessage = nil
        do {
            switch destination {
            case .album(let id):
                album = try await client.album(id: id)
            case .artist(let name):
                let page = try await client.artists(query: name)
                artist = page.items.first { $0.name == name }
                    ?? page.items.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
                if artist == nil { errorMessage = L10n("trackAction.artistNotFound") }
            }
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }
}

/// Sheet that appends one track to a manual playlist (or creates a new one).
struct AddToPlaylistSheet: View {
    let client: WildstringClient
    let trackID: String

    @Environment(\.dismiss) private var dismiss
    @State private var playlists: [Playlist] = []
    @State private var newName = ""
    @State private var message: String?
    @State private var isBusy = false

    var body: some View {
        NavigationStack {
            List {
                if !playlists.isEmpty {
                    Section(L10n("trackAction.addToPlaylist")) {
                        ForEach(playlists) { playlist in
                            Button {
                                Task { await add(to: playlist) }
                            } label: {
                                HStack {
                                    Text(playlist.name)
                                    Spacer()
                                    Text(L10n("trackAction.trackCount", playlist.trackCount))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .disabled(isBusy)
                        }
                    }
                }
                Section(L10n("trackAction.newPlaylist")) {
                    HStack {
                        TextField(L10n("trackAction.playlistName"), text: $newName)
                        Button(L10n("trackAction.createAndAdd")) {
                            Task { await createAndAdd() }
                        }
                        .disabled(
                            isBusy || newName.trimmingCharacters(in: .whitespaces).isEmpty
                        )
                    }
                }
                if let message {
                    Section {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(L10n("trackAction.addToPlaylist"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(L10n("trackAction.cancel")) { dismiss() }
                }
            }
            .task { await load() }
        }
        .presentationDetents([.medium, .large])
    }

    private func load() async {
        do {
            let page = try await client.playlists()
            playlists = page.items.filter(\.isEditable)
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func add(to playlist: Playlist) async {
        isBusy = true
        message = nil
        defer { isBusy = false }
        do {
            let fresh = try await client.playlist(id: playlist.id)
            try await client.addTracks(
                playlistID: fresh.id,
                trackIDs: [trackID],
                version: fresh.version
            )
            dismiss()
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = L10n("trackAction.playlistConflict")
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func createAndAdd() async {
        isBusy = true
        message = nil
        defer { isBusy = false }
        do {
            let name = newName.trimmingCharacters(in: .whitespaces)
            let created = try await client.createPlaylist(name: name)
            try await client.addTracks(
                playlistID: created.id,
                trackIDs: [trackID],
                version: created.version
            )
            dismiss()
        } catch {
            message = ErrorText.message(for: error)
        }
    }
}
