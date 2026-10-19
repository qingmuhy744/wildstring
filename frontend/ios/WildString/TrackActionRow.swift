import CoreNetwork
import CorePlayback
import SwiftUI

/// Wraps a track row with the shared context menu: favorite toggle,
/// "add to playlist" and offline download.
struct TrackActionRow<Content: View>: View {
    let client: WildstringClient
    let track: Track
    @ViewBuilder let content: () -> Content

    @Environment(FavoritesModel.self) private var favorites
    @Environment(OfflineModel.self) private var offline
    @Environment(\.isAdmin) private var isAdmin
    @State private var addingToPlaylist = false
    @State private var editingMetadata = false
    @State private var editingLyrics = false

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
                    Task { await favorites.toggle(track.id) }
                } label: {
                    Label(
                        favorites.isFavorite(track.id) ? "取消收藏" : "收藏",
                        systemImage: favorites.isFavorite(track.id) ? "heart.slash" : "heart"
                    )
                }
                Button {
                    addingToPlaylist = true
                } label: {
                    Label("加入歌单", systemImage: "text.badge.plus")
                }
                if isDownloaded {
                    Button(role: .destructive) {
                        Task { await offline.remove(trackID: track.id) }
                    } label: {
                        Label("删除下载", systemImage: "arrow.down.circle.slash")
                    }
                } else {
                    Button {
                        Task { await offline.download(track) }
                    } label: {
                        Label("下载", systemImage: "arrow.down.circle")
                    }
                    .disabled(isDownloading)
                }
                if isAdmin {
                    Button {
                        editingMetadata = true
                    } label: {
                        Label("编辑元数据", systemImage: "square.and.pencil")
                    }
                    Button {
                        editingLyrics = true
                    } label: {
                        Label("编辑歌词", systemImage: "text.quote")
                    }
                }
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
                    Section("加入歌单") {
                        ForEach(playlists) { playlist in
                            Button {
                                Task { await add(to: playlist) }
                            } label: {
                                HStack {
                                    Text(playlist.name)
                                    Spacer()
                                    Text("\(playlist.trackCount) 首")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .disabled(isBusy)
                        }
                    }
                }
                Section("新建歌单") {
                    HStack {
                        TextField("歌单名称", text: $newName)
                        Button("新建并加入") {
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
            .navigationTitle("加入歌单")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
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
            message = "歌单已更新，已刷新列表，请重试"
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
