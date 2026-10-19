import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct AlbumDetailView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let album: Album

    @State private var loader: PagedListModel<Track>?

    var body: some View {
        VStack(spacing: 0) {
            header
            if let loader {
                LoadedList(
                    loader: loader,
                    emptyTitle: "没有曲目",
                    emptyIcon: "music.note"
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
                }
            } else {
                ProgressView()
                Spacer()
            }
        }
        .navigationTitle(album.title)
        .navigationBarTitleDisplayMode(.inline)
        .miniPlayer(playback, client: client)
        .task {
            if loader == nil {
                let loader = PagedListModel<Track>(pageSize: 200) { [client] limit, offset in
                    try await client.albumTracks(albumId: album.id, limit: limit, offset: offset)
                }
                self.loader = loader
                await loader.loadInitial()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            CoverImage(client: client, trackID: album.coverTrackId, size: 88)
            VStack(alignment: .leading, spacing: 4) {
                Text(album.title)
                    .font(.headline)
                    .lineLimit(2)
                Text(album.artistDisplay)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text("\(album.trackCount) 首")
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
}

@MainActor
struct ArtistDetailView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let artist: Artist

    enum Section: String, CaseIterable {
        case songs = "歌曲"
        case albums = "专辑"
    }

    @State private var section: Section = .songs
    @State private var songsLoader: PagedListModel<Track>?
    @State private var albumsLoader: PagedListModel<Album>?

    var body: some View {
        VStack(spacing: 0) {
            header
            Picker("分类", selection: $section) {
                ForEach(Section.allCases, id: \.self) { section in
                    Text(section.rawValue).tag(section)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 6)
            content
        }
        .navigationTitle(artist.name)
        .navigationBarTitleDisplayMode(.inline)
        .miniPlayer(playback, client: client)
        .task { await ensureSectionLoaded() }
        .onChange(of: section) { _, _ in
            Task { await ensureSectionLoaded() }
        }
    }

    @ViewBuilder private var content: some View {
        switch section {
        case .songs:
            if let songsLoader {
                LoadedList(
                    loader: songsLoader,
                    emptyTitle: "没有歌曲",
                    emptyIcon: "music.note"
                ) { track in
                    TrackActionRow(client: client, track: track) {
                        Button {
                            playTracks(songsLoader.items, startingAt: track, using: playback)
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
            } else {
                ProgressView()
            }
        case .albums:
            if let albumsLoader {
                LoadedList(
                    loader: albumsLoader,
                    emptyTitle: "没有专辑",
                    emptyIcon: "square.stack"
                ) { album in
                    NavigationLink(value: album) {
                        AlbumRow(client: client, album: album)
                    }
                }
            } else {
                ProgressView()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            CoverImage(client: client, trackID: artist.coverTrackId, size: 64, circular: true)
            VStack(alignment: .leading, spacing: 3) {
                Text(artist.name)
                    .font(.headline)
                    .lineLimit(1)
                Text("\(artist.trackCount) 首 · \(artist.albumCount) 张专辑")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    private func ensureSectionLoaded() async {
        switch section {
        case .songs:
            if songsLoader == nil {
                songsLoader = PagedListModel<Track>(pageSize: 200) { [client] limit, offset in
                    try await client.artistTracks(
                        artistId: artist.id,
                        limit: limit,
                        offset: offset
                    )
                }
            }
            if songsLoader?.didLoadOnce == false {
                await songsLoader?.loadInitial()
            }
        case .albums:
            if albumsLoader == nil {
                albumsLoader = PagedListModel<Album>(pageSize: 50) { [client] limit, offset in
                    try await client.artistAlbums(
                        artistId: artist.id,
                        limit: limit,
                        offset: offset
                    )
                }
            }
            if albumsLoader?.didLoadOnce == false {
                await albumsLoader?.loadInitial()
            }
        }
    }
}
