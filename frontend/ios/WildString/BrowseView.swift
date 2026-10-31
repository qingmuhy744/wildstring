import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct BrowseView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let server: String
    let username: String
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
    @State private var browseGroups: [BrowseGroup] = []
    @State private var demoMetadataTrack: Track?
    @State private var demoLyricsTrack: Track?
    @State private var demoSuggestionsTrack: Track?
    @State private var demoReviewTrack: Track?
    @State private var songSort: TrackSort
    @State private var songOrder: CatalogSortOrder
    @State private var albumSort: AlbumSort
    @State private var albumOrder: CatalogSortOrder
    @State private var libraries: [MusicLibrary] = []
    @State private var artistRole = ""
    @State private var showingSearch = false

    init(
        client: WildstringClient,
        playback: PlaybackService,
        server: String,
        username: String,
        autoPlayFirst: Bool = false
    ) {
        self.client = client
        self.playback = playback
        self.server = server
        self.username = username
        self.autoPlayFirst = autoPlayFirst
        let preferences = CatalogSortPreference(origin: client.server.origin)
        _songSort = State(initialValue: preferences.songSort)
        _songOrder = State(initialValue: preferences.songOrder)
        _albumSort = State(initialValue: preferences.albumSort)
        _albumOrder = State(initialValue: preferences.albumOrder)
    }

    private var preferences: CatalogSortPreference {
        CatalogSortPreference(origin: client.server.origin)
    }

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
                if section == .artists {
                    Picker("角色", selection: $artistRole) {
                        Text("全部").tag("")
                        Text("艺人").tag("artist")
                        Text("专辑艺人").tag("album_artist")
                        Text("演唱").tag("vocalist")
                        Text("作词").tag("lyricist")
                        Text("作曲").tag("composer")
                        Text("编曲").tag("arranger")
                    }
                    .pickerStyle(.menu)
                    .padding(.horizontal)
                }

                content
            }
            .navigationTitle("音乐")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showingSearch = true
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .accessibilityLabel("搜索")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if libraries.count > 1 {
                        libraryMenu
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if section != .artists {
                        sortMenu
                    }
                }
            }
            .sheet(isPresented: $showingSearch) {
                SearchView(client: client, playback: playback)
            }
            .navigationDestination(for: Album.self) { album in
                AlbumDetailView(client: client, playback: playback, album: album)
            }
            .navigationDestination(for: Artist.self) { artist in
                ArtistDetailView(client: client, playback: playback, artist: artist)
            }
            .sheet(item: $demoMetadataTrack) { track in
                MetadataEditView(client: client, track: track)
            }
            .sheet(item: $demoLyricsTrack) { track in
                LyricsEditView(client: client, track: track)
            }
            .sheet(item: $demoSuggestionsTrack) { track in
                MetadataSuggestionsView(client: client, track: track)
            }
            .sheet(item: $demoReviewTrack) { track in
                MetadataReviewView(client: client, initialTrack: track)
            }
            .miniPlayer(playback, client: client)
        }
        .task { await ensureSectionLoaded() }
        .task { await loadLibraries() }
        .task { openSearchForDemoIfNeeded() }
        .onChange(of: section) { _, _ in
            Task { await ensureSectionLoaded() }
        }
        .onChange(of: artistRole) { _, _ in
            artistsLoader = nil
            Task { await ensureSectionLoaded() }
        }
    }

    private var libraryMenu: some View {
        Menu {
            Button("默认曲库") { selectLibrary(nil) }
            ForEach(libraries) { library in
                Button(library.name) { selectLibrary(library.id) }
            }
        } label: {
            Image(systemName: "books.vertical")
        }
        .accessibilityLabel("曲库")
    }

    private func selectLibrary(_ id: String?) {
        client.selectLibrary(id)
        AccountPreferences(server: server, username: username).setLibraryID(id)
        songsLoader = nil
        albumsLoader = nil
        artistsLoader = nil
        browseGroups = []
        Task { await ensureSectionLoaded() }
    }

    private func loadLibraries() async {
        guard let loaded = try? await client.libraries() else { return }
        libraries = loaded.filter(\.enabled)
        let saved = AccountPreferences(server: server, username: username).libraryID
        if let saved, !libraries.contains(where: { $0.id == saved }) {
            selectLibrary(nil)
        }
    }

    private func openSearchForDemoIfNeeded() {
        #if DEBUG
            guard ProcessInfo.processInfo.environment["WILDSTRING_DEMO_TAB"] == "search" else { return }
            showingSearch = true
        #endif
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
                .overlay(alignment: .trailing) {
                    if songSort == .name, songOrder == .asc, !browseGroups.isEmpty {
                        LetterIndexBar(groups: browseGroups) { group in
                            guard let offset = group.offset else { return }
                            Haptics.tap()
                            Task { await songsLoader.jump(toOffset: offset) }
                        }
                        .padding(.trailing, 2)
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
                let sort = songSort
                let order = songOrder
                songsLoader = PagedListModel<Track>(pageSize: 100) { [client] limit, offset in
                    try await client.tracks(
                        limit: limit,
                        offset: offset,
                        sort: sort,
                        order: order
                    )
                }
            }
            if songsLoader?.didLoadOnce == false {
                await songsLoader?.loadInitial()
                await loadBrowseIndexIfNeeded()
                autoPlayIfNeeded()
            }
        case .albums:
            if albumsLoader == nil {
                let sort = albumSort
                let order = albumOrder
                albumsLoader = PagedListModel<Album>(pageSize: 50) { [client] limit, offset in
                    try await client.albums(
                        limit: limit,
                        offset: offset,
                        sort: sort,
                        order: order
                    )
                }
            }
            if albumsLoader?.didLoadOnce == false {
                await albumsLoader?.loadInitial()
                openDemoAlbumIfNeeded()
            }
        case .artists:
            if artistsLoader == nil {
                let role = artistRole
                artistsLoader = PagedListModel<Artist>(pageSize: 50) { [client] limit, offset in
                    try await client.artists(
                        limit: limit,
                        offset: offset,
                        role: role.isEmpty ? nil : role
                    )
                }
            }
            if artistsLoader?.didLoadOnce == false {
                await artistsLoader?.loadInitial()
            }
        }
    }

    private func autoPlayIfNeeded() {
        openDemoEditorsIfNeeded()
        guard autoPlayFirst, !didAutoPlay, let first = songsLoader?.items.first else { return }
        didAutoPlay = true
        playTracks(songsLoader?.items ?? [], startingAt: first, using: playback)
    }

    private func loadBrowseIndexIfNeeded() async {
        guard browseGroups.isEmpty else { return }
        browseGroups = (try? await client.browseIndex())?.groups ?? []
    }

    private var sortMenu: some View {
        Menu {
            if section == .songs {
                ForEach(CatalogSorting.songSorts, id: \.self) { sort in
                    Button {
                        choose(songSort: sort)
                    } label: {
                        if songSort == sort {
                            Label(CatalogSorting.label(sort), systemImage: "checkmark")
                        } else {
                            Text(CatalogSorting.label(sort))
                        }
                    }
                }
                Divider()
                Button {
                    toggleSongOrder()
                } label: {
                    Label(
                        songOrder == .asc ? "改为降序" : "改为升序",
                        systemImage: songOrder == .asc ? "arrow.down" : "arrow.up"
                    )
                }
            } else if section == .albums {
                ForEach(CatalogSorting.albumSorts, id: \.self) { sort in
                    Button {
                        choose(albumSort: sort)
                    } label: {
                        if albumSort == sort {
                            Label(CatalogSorting.label(sort), systemImage: "checkmark")
                        } else {
                            Text(CatalogSorting.label(sort))
                        }
                    }
                }
                Divider()
                Button {
                    toggleAlbumOrder()
                } label: {
                    Label(
                        albumOrder == .asc ? "改为降序" : "改为升序",
                        systemImage: albumOrder == .asc ? "arrow.down" : "arrow.up"
                    )
                }
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down")
        }
        .accessibilityLabel("排序")
    }

    private func choose(songSort sort: TrackSort) {
        guard sort != songSort else { return }
        songSort = sort
        songOrder = CatalogSorting.defaultOrder(for: sort)
        preferences.songSort = songSort
        preferences.songOrder = songOrder
        songsLoader = nil
        Task { await ensureSectionLoaded() }
    }

    private func toggleSongOrder() {
        songOrder = songOrder == .asc ? .desc : .asc
        preferences.songOrder = songOrder
        songsLoader = nil
        Task { await ensureSectionLoaded() }
    }

    private func choose(albumSort sort: AlbumSort) {
        guard sort != albumSort else { return }
        albumSort = sort
        albumOrder = CatalogSorting.defaultOrder(for: sort)
        preferences.albumSort = albumSort
        preferences.albumOrder = albumOrder
        albumsLoader = nil
        Task { await ensureSectionLoaded() }
    }

    private func toggleAlbumOrder() {
        albumOrder = albumOrder == .asc ? .desc : .asc
        preferences.albumOrder = albumOrder
        albumsLoader = nil
        Task { await ensureSectionLoaded() }
    }

    private func openDemoEditorsIfNeeded() {
        #if DEBUG
            guard let first = songsLoader?.items.first else { return }
            let environment = ProcessInfo.processInfo.environment
            if environment["WILDSTRING_DEMO_OPEN_METADATA"] == "1", demoMetadataTrack == nil {
                demoMetadataTrack = first
            }
            if environment["WILDSTRING_DEMO_OPEN_LYRICS_EDITOR"] == "1", demoLyricsTrack == nil {
                demoLyricsTrack = first
            }
            if environment["WILDSTRING_DEMO_OPEN_SUGGESTIONS"] == "1", demoSuggestionsTrack == nil {
                demoSuggestionsTrack = first
            }
            if environment["WILDSTRING_DEMO_OPEN_REVIEW"] == "1", demoReviewTrack == nil {
                demoReviewTrack = first
            }
        #endif
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
