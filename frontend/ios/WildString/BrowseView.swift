import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct BrowseView: View {
    let client: WildstringClient
    let playback: PlaybackService
    var autoPlayFirst = false

    enum Section: String, CaseIterable {
        case songs = "歌曲"
        case albums = "专辑"
        case artists = "艺人"
    }

    @State private var section: Section = Self.demoSection
    @State private var path = NavigationPath()
    @State private var songsLoader: PagedListModel<Track>?
    @State private var albumsLoader: PagedListModel<Album>?
    @State private var artistsLoader: PagedListModel<Artist>?
    @State private var didAutoPlay = false

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
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
            .navigationTitle("曲库")
            .navigationDestination(for: Album.self) { album in
                AlbumDetailView(client: client, playback: playback, album: album)
            }
            .navigationDestination(for: Artist.self) { artist in
                ArtistDetailView(client: client, playback: playback, artist: artist)
            }
            .miniPlayer(playback, client: client)
        }
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
                    emptyTitle: "曲库为空",
                    emptyIcon: "music.note.list"
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
        case .artists:
            if let artistsLoader {
                LoadedList(
                    loader: artistsLoader,
                    emptyTitle: "没有艺人",
                    emptyIcon: "person.2"
                ) { artist in
                    NavigationLink(value: artist) {
                        ArtistRow(client: client, artist: artist)
                    }
                }
            } else {
                ProgressView()
            }
        }
    }

    private func ensureSectionLoaded() async {
        switch section {
        case .songs:
            if songsLoader == nil {
                songsLoader = PagedListModel<Track>(pageSize: 100) { [client] limit, offset in
                    try await client.tracks(limit: limit, offset: offset)
                }
            }
            if songsLoader?.didLoadOnce == false {
                await songsLoader?.loadInitial()
                autoPlayIfNeeded()
            }
        case .albums:
            if albumsLoader == nil {
                albumsLoader = PagedListModel<Album>(pageSize: 50) { [client] limit, offset in
                    try await client.albums(limit: limit, offset: offset)
                }
            }
            if albumsLoader?.didLoadOnce == false {
                await albumsLoader?.loadInitial()
                openDemoAlbumIfNeeded()
            }
        case .artists:
            if artistsLoader == nil {
                artistsLoader = PagedListModel<Artist>(pageSize: 50) { [client] limit, offset in
                    try await client.artists(limit: limit, offset: offset)
                }
            }
            if artistsLoader?.didLoadOnce == false {
                await artistsLoader?.loadInitial()
            }
        }
    }

    private func autoPlayIfNeeded() {
        guard autoPlayFirst, !didAutoPlay, let first = songsLoader?.items.first else { return }
        didAutoPlay = true
        playTracks(songsLoader?.items ?? [], startingAt: first, using: playback)
    }

    /// Debug-only hooks used by the simulator verification runs.
    private static var demoSection: Section {
        #if DEBUG
            switch ProcessInfo.processInfo.environment["WILDSTRING_DEMO_SECTION"] {
            case "albums": return .albums
            case "artists": return .artists
            default: return .songs
            }
        #else
            return .songs
        #endif
    }

    private func openDemoAlbumIfNeeded() {
        #if DEBUG
            guard ProcessInfo.processInfo.environment["WILDSTRING_DEMO_OPEN_ALBUM"] == "1",
                path.isEmpty, let first = albumsLoader?.items.first
            else { return }
            path.append(first)
        #endif
    }
}
