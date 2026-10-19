import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct PlaylistDetailView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let playlist: Playlist

    @State private var current: Playlist?
    @State private var loader: PagedListModel<Track>?
    @State private var message: String?

    private var detail: Playlist { current ?? playlist }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 4)
            }
            if let loader {
                LoadedList(
                    loader: loader,
                    emptyTitle: "歌单为空",
                    emptyIcon: "music.note.list",
                    onMove: onMoveHandler
                ) { track in
                    TrackActionRow(client: client, track: track) {
                        Button {
                            playTracks(loader.items, startingAt: track, using: playback)
                        } label: {
                            TrackRow(
                                client: client,
                                track: track,
                                isCurrent: playback.currentItem?.trackID == track.id
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    .swipeActions(edge: .trailing) {
                        if detail.isEditable {
                            Button("移除", role: .destructive) {
                                Task { await remove(track) }
                            }
                        }
                    }
                }
            } else {
                ProgressView()
                Spacer()
            }
        }
        .navigationTitle(detail.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if detail.isEditable, !(loader?.items.isEmpty ?? true) {
                ToolbarItem(placement: .topBarTrailing) { EditButton() }
            }
        }
        .miniPlayer(playback, client: client)
        .task { await load() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            CoverImage(
                client: client,
                trackID: detail.coverTrackId,
                size: 88
            )
            VStack(alignment: .leading, spacing: 4) {
                Text(detail.name)
                    .font(.headline)
                    .lineLimit(2)
                Text(kindLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("\(detail.trackCount) 首")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                Button {
                    if let first = loader?.items.first {
                        playTracks(loader?.items ?? [], startingAt: first, using: playback)
                    }
                } label: {
                    Label("播放全部", systemImage: "play.fill")
                        .font(.subheadline.bold())
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .padding(.top, 2)
                .disabled(loader?.items.isEmpty != false)
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var kindLabel: String {
        if detail.isFavorites { return "自动收藏" }
        if detail.isSmart { return "规则歌单" }
        return "普通歌单"
    }

    private var onMoveHandler: ((IndexSet, Int) -> Void)? {
        guard detail.isEditable else { return nil }
        return { offsets, destination in
            reorder(from: offsets, to: destination)
        }
    }

    private func reorder(from offsets: IndexSet, to destination: Int) {
        guard let loader, let current, current.isEditable else { return }
        if current.trackCount > loader.items.count {
            message = "请先滚动加载完整歌单再排序"
            return
        }
        Haptics.selection()
        loader.applyReorder(fromOffsets: offsets, toOffset: destination)
        let ids = loader.items.map(\.id)
        Task { await submitOrder(ids) }
    }

    private func submitOrder(_ ids: [String]) async {
        guard let current else { return }
        do {
            try await client.reorderTracks(
                playlistID: current.id,
                trackIDs: ids,
                version: current.version
            )
            self.current = try await client.playlist(id: current.id)
            message = nil
        } catch let error as APIError where error.statusCode == 409 {
            self.current = try? await client.playlist(id: current.id)
            await loader?.loadInitial()
            message = "歌单已更新，已刷新，请重试"
        } catch {
            await loader?.loadInitial()
            message = ErrorText.message(for: error)
        }
    }

    private func load() async {
        do {
            current = try await client.playlist(id: playlist.id)
        } catch {
            message = ErrorText.message(for: error)
        }
        if loader == nil {
            let loader = PagedListModel<Track>(pageSize: 200) { [client, id = playlist.id] limit, offset in
                try await client.playlistTracks(playlistID: id, limit: limit, offset: offset)
            }
            self.loader = loader
            await loader.loadInitial()
        }
    }

    private func remove(_ track: Track) async {
        guard let version = current?.version else { return }
        do {
            try await client.removeTrack(
                playlistID: detail.id,
                trackID: track.id,
                version: version
            )
            current = try await client.playlist(id: detail.id)
            await loader?.loadInitial()
            message = nil
        } catch let error as APIError where error.statusCode == 409 {
            current = try? await client.playlist(id: detail.id)
            await loader?.loadInitial()
            message = "歌单已更新，已刷新，请重试"
        } catch {
            message = ErrorText.message(for: error)
        }
    }
}
