import CoreNetwork
import CorePlayback
import SwiftUI

/// Shared playback, catalog and library actions for a track row.
struct TrackActionRow<Content: View, ExtraActions: View>: View {
    let client: WildstringClient
    let playback: PlaybackService
    let track: Track
    let play: () -> Void
    @ViewBuilder let content: () -> Content
    @ViewBuilder let extraActions: () -> ExtraActions

    init(client: WildstringClient, playback: PlaybackService, track: Track, play: @escaping () -> Void, @ViewBuilder content: @escaping () -> Content, @ViewBuilder extraActions: @escaping () -> ExtraActions) {
        self.client = client
        self.playback = playback
        self.track = track
        self.play = play
        self.content = content
        self.extraActions = extraActions
    }

    init(client: WildstringClient, playback: PlaybackService, track: Track, play: @escaping () -> Void, @ViewBuilder content: @escaping () -> Content) where ExtraActions == EmptyView {
        self.init(client: client, playback: playback, track: track, play: play, content: content) { EmptyView() }
    }

    @Environment(FavoritesModel.self) private var favorites
    @Environment(OfflineModel.self) private var offline
    @Environment(\.trackSelection) private var selection
    @Environment(\.canEditMetadata) private var canEditMetadata
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
        row
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

    @ViewBuilder private var row: some View {
        if let selection, selection.isActive {
            Button {
                selection.toggle(track)
            } label: {
                HStack {
                    TrackRow(client: client, track: track, isCurrent: playback.currentItem?.trackID == track.id)
                    Image(systemName: selection.ids.contains(track.id) ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selection.ids.contains(track.id) ? Color.wildAccentText : .secondary)
                        .frame(width: 44, height: 44)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!track.isAvailable)
            .accessibilityAddTraits(selection.ids.contains(track.id) ? .isSelected : [])
        } else if let selection {
            HStack(spacing: 0) {
                content()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .gesture(LongPressGesture().exclusively(before: TapGesture()).onEnded { result in
                        switch result {
                        case .first: selection.toggle(track)
                        case .second: play()
                        }
                    })
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { play() }
                    .accessibilityAction(named: L10n("bulk.select")) { selection.toggle(track) }
                Menu {
                    Button(L10n("bulk.select"), systemImage: "checkmark.circle") { selection.toggle(track) }
                        .disabled(!track.isAvailable)
                    actions
                } label: {
                    Image(systemName: "ellipsis").foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(L10n("bulk.actions"))
            }
        } else {
            Button(action: play, label: content)
                .buttonStyle(.plain)
                .contextMenu { actions }
        }
    }

    @ViewBuilder private var actions: some View {
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
        if canEditMetadata {
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
        }
        if isAdmin {
            Button {
                reviewingMetadata = true
            } label: {
                Label(L10n("trackAction.batchReview"), systemImage: "checklist")
            }
        }
        extraActions()
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
    let trackIDs: [String]
    var onAdded: () -> Void = {}

    init(client: WildstringClient, trackID: String) {
        self.init(client: client, trackIDs: [trackID])
    }

    init(client: WildstringClient, trackIDs: [String], onAdded: @escaping () -> Void = {}) {
        self.client = client
        self.trackIDs = trackIDs
        self.onAdded = onAdded
    }

    @Environment(\.dismiss) private var dismiss
    @State private var playlists: [Playlist] = []
    @State private var newName = ""
    @State private var message: String?
    @State private var isBusy = false
    @State private var createdPlaylist: Playlist?

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
            let loader = PagedListModel<Playlist> { [client] limit, offset in
                try await client.playlists(limit: limit, offset: offset)
            }
            playlists = try await loader.allItems().filter(\.isEditable)
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func add(to playlist: Playlist) async {
        guard (1...5000).contains(trackIDs.count) else {
            message = L10n("consumer.playlistLimit")
            return
        }
        isBusy = true
        message = nil
        defer { isBusy = false }
        do {
            let fresh = try await client.playlist(id: playlist.id)
            try await client.addTracks(
                playlistID: fresh.id,
                trackIDs: trackIDs,
                version: fresh.version
            )
            onAdded()
            dismiss()
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = L10n("trackAction.playlistConflict")
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func createAndAdd() async {
        guard (1...5000).contains(trackIDs.count) else {
            message = L10n("consumer.playlistLimit")
            return
        }
        isBusy = true
        message = nil
        defer { isBusy = false }
        do {
            let name = newName.trimmingCharacters(in: .whitespaces)
            let created: Playlist
            if let createdPlaylist, createdPlaylist.name == name {
                created = try await client.playlist(id: createdPlaylist.id)
            } else {
                created = try await client.createPlaylist(name: name)
                createdPlaylist = created
            }
            try await client.addTracks(
                playlistID: created.id,
                trackIDs: trackIDs,
                version: created.version
            )
            onAdded()
            dismiss()
        } catch {
            message = ErrorText.message(for: error)
        }
    }
}
