import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct AlbumDetailView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let album: Album

    @State private var model: AlbumTracksModel?
    @State private var sort: TrackSort
    @State private var order: CatalogSortOrder

    init(client: WildstringClient, playback: PlaybackService, album: Album) {
        self.client = client
        self.playback = playback
        self.album = album
        let preferences = CatalogSortPreference(origin: client.server.origin)
        _sort = State(initialValue: preferences.albumTracksSort)
        _order = State(initialValue: preferences.albumTracksOrder)
    }

    private var preferences: CatalogSortPreference {
        CatalogSortPreference(origin: client.server.origin)
    }

    private var groupsDiscs: Bool { sort == .trackNumber }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let model {
                List {
                    ForEach(sections(model)) { section in
                        Section {
                            ForEach(section.tracks) { track in
                                TrackActionRow(client: client, track: track) {
                                    Button {
                                        playTracks(model.items, startingAt: track, using: playback)
                                    } label: {
                                        TrackRow(
                                            client: client,
                                            track: track,
                                            isCurrent: playback.currentItem?.trackID == track.id,
                                            showsDisc: !groupsDiscs
                                        )
                                    }
                                    .buttonStyle(.plain)
                                }
                                .onAppear {
                                    if model.items.last?.id == track.id {
                                        Task { await model.loadMore() }
                                    }
                                }
                            }
                        } header: {
                            if let title = section.title {
                                Text(title)
                            }
                        }
                    }
                    if model.isLoading, !model.items.isEmpty {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                    }
                    if let message = model.errorMessage, !model.items.isEmpty {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                .listStyle(.plain)
                .refreshable { await model.loadInitial() }
                .overlay {
                    if !model.didLoadOnce {
                        ProgressView()
                    } else if model.items.isEmpty {
                        ContentUnavailableView(
                            L10n("detailView.noTracks"),
                            systemImage: "music.note",
                            description: Text(model.errorMessage ?? L10n("detailView.emptyAlbumDescription"))
                        )
                    }
                }
            } else {
                ProgressView()
                Spacer()
            }
        }
        .navigationTitle(album.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                sortMenu
            }
        }
        .miniPlayer(playback, client: client)
        .task { await ensureLoaded() }
    }

    private struct TrackSection: Identifiable {
        let id: Int
        let title: String?
        let tracks: [Track]
    }

    private func sections(_ model: AlbumTracksModel) -> [TrackSection] {
        guard groupsDiscs, model.discs.count > 1 else {
            return [TrackSection(id: 0, title: nil, tracks: model.items)]
        }
        var sections: [TrackSection] = []
        for track in model.items {
            let number = track.discNumber ?? 1
            if var last = sections.last, last.id == number {
                last = TrackSection(id: number, title: last.title, tracks: last.tracks + [track])
                sections[sections.count - 1] = last
            } else {
                let count = model.discs.first { $0.number == number }?.trackCount
                let title = count.map {
                    L10n("detailView.discHeader", String(format: "%02d", number), $0)
                } ?? "DISC \(String(format: "%02d", number))"
                sections.append(TrackSection(id: number, title: title, tracks: [track]))
            }
        }
        return sections
    }

    private func ensureLoaded() async {
        guard model == nil else { return }
        let sort = sort
        let order = order
        let model = AlbumTracksModel { [client, album] limit, offset in
            try await client.albumTracks(
                albumId: album.id,
                limit: limit,
                offset: offset,
                sort: sort,
                order: order
            )
        }
        self.model = model
        await model.loadInitial()
    }

    private func reload() {
        model = nil
        Task { await ensureLoaded() }
    }

    private var sortMenu: some View {
        Menu {
            ForEach(CatalogSorting.songSorts, id: \.self) { option in
                Button {
                    guard option != sort else { return }
                    sort = option
                    order = CatalogSorting.defaultOrder(for: option)
                    preferences.albumTracksSort = sort
                    preferences.albumTracksOrder = order
                    reload()
                } label: {
                    if sort == option {
                        Label(CatalogSorting.label(option), systemImage: "checkmark")
                    } else {
                        Text(CatalogSorting.label(option))
                    }
                }
            }
            Divider()
            Button {
                order = order == .asc ? .desc : .asc
                preferences.albumTracksOrder = order
                reload()
            } label: {
                Label(
                    order == .asc ? L10n("detailView.sortDesc") : L10n("detailView.sortAsc"),
                    systemImage: order == .asc ? "arrow.down" : "arrow.up"
                )
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down")
        }
        .accessibilityLabel(L10n("detailView.sort"))
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
                Text(L10n("detailView.trackCount", album.trackCount))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                Button {
                    if let first = model?.items.first(where: \.isAvailable) ?? model?.items.first {
                        playTracks(model?.items ?? [], startingAt: first, using: playback)
                    }
                } label: {
                    Label(L10n("detailView.playAll"), systemImage: "play.fill")
                        .font(.subheadline.bold())
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .padding(.top, 2)
                .disabled(model?.items.isEmpty != false)
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
        case songs
        case albums

        var title: String {
            switch self {
            case .songs: return L10n("detailView.sectionSongs")
            case .albums: return L10n("detailView.sectionAlbums")
            }
        }
    }

    @State private var section: Section = .songs
    @State private var songsLoader: PagedListModel<Track>?
    @State private var albumsLoader: PagedListModel<Album>?
    @State private var songSort: TrackSort
    @State private var songOrder: CatalogSortOrder

    init(client: WildstringClient, playback: PlaybackService, artist: Artist) {
        self.client = client
        self.playback = playback
        self.artist = artist
        let preferences = CatalogSortPreference(origin: client.server.origin)
        _songSort = State(initialValue: preferences.artistSongSort)
        _songOrder = State(initialValue: preferences.artistSongOrder)
    }

    private var preferences: CatalogSortPreference {
        CatalogSortPreference(origin: client.server.origin)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Picker(L10n("detailView.category"), selection: $section) {
                ForEach(Section.allCases, id: \.self) { section in
                    Text(section.title).tag(section)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 6)
            content
        }
        .navigationTitle(artist.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if section == .songs {
                    sortMenu
                }
            }
        }
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
                    emptyTitle: L10n("detailView.emptySongs"),
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
                    emptyTitle: L10n("detailView.emptyAlbums"),
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
                Text(L10n("detailView.artistSummary", artist.trackCount, artist.albumCount))
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
                let sort = songSort
                let order = songOrder
                songsLoader = PagedListModel<Track>(pageSize: 200) { [client] limit, offset in
                    try await client.artistTracks(
                        artistId: artist.id,
                        limit: limit,
                        offset: offset,
                        sort: sort,
                        order: order
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

    private var sortMenu: some View {
        Menu {
            ForEach(CatalogSorting.songSorts, id: \.self) { option in
                Button {
                    guard option != songSort else { return }
                    songSort = option
                    songOrder = CatalogSorting.defaultOrder(for: option)
                    preferences.artistSongSort = songSort
                    preferences.artistSongOrder = songOrder
                    songsLoader = nil
                    Task { await ensureSectionLoaded() }
                } label: {
                    if songSort == option {
                        Label(CatalogSorting.label(option), systemImage: "checkmark")
                    } else {
                        Text(CatalogSorting.label(option))
                    }
                }
            }
            Divider()
            Button {
                songOrder = songOrder == .asc ? .desc : .asc
                preferences.artistSongOrder = songOrder
                songsLoader = nil
                Task { await ensureSectionLoaded() }
            } label: {
                Label(
                    songOrder == .asc ? L10n("detailView.sortDesc") : L10n("detailView.sortAsc"),
                    systemImage: songOrder == .asc ? "arrow.down" : "arrow.up"
                )
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down")
        }
        .accessibilityLabel(L10n("detailView.sort"))
    }
}
