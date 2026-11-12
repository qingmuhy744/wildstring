import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
@Observable
final class MacFavorites {
  private(set) var ids: Set<String> = []
  private let client: WildstringClient

  init(client: WildstringClient) {
    self.client = client
  }

  func load() async {
    async let tracks = try? client.favoriteIDs()
    async let podcasts = try? client.podcastEpisodeFavoriteIDs()
    let loadedTracks = await tracks ?? []
    let loadedPodcasts = await podcasts ?? []
    var combined = loadedTracks
    for p in loadedPodcasts {
      combined.insert(p)
      combined.insert("podcast_ep_\(p)")
    }
    ids = combined
  }

  func isFavorite(_ trackID: String) -> Bool {
    if ids.contains(trackID) { return true }
    if let epID = PlaybackService.podcastEpisodeID(trackID) {
      return ids.contains(epID)
    }
    return false
  }

  func toggle(_ trackID: String, isPodcast: Bool = false) async {
    let currentlyLoved = isFavorite(trackID)
    let loved = !currentlyLoved
    let podcast = isPodcast || trackID.hasPrefix("podcast_ep_")
    let episodeID = podcast ? (PlaybackService.podcastEpisodeID(trackID) ?? trackID) : nil
    let targetID = episodeID ?? trackID

    if loved {
      ids.insert(trackID)
      if let ep = episodeID { ids.insert(ep) }
    } else {
      ids.remove(trackID)
      if let ep = episodeID { ids.remove(ep) }
    }

    do {
      if isPodcast || episodeID != nil {
        try await client.favoritePodcastEpisode(episodeID: targetID, loved: loved)
      } else {
        try await client.setFavorite(trackID: trackID, loved: loved)
      }
    } catch {
      if loved {
        ids.remove(trackID)
        if let ep = episodeID { ids.remove(ep) }
      } else {
        ids.insert(trackID)
        if let ep = episodeID { ids.insert(ep) }
      }
    }
  }
}

@MainActor
enum MacPlayback {
  static func item(_ track: Track) -> PlaybackService.Item {
    PlaybackService.Item(
      trackID: track.id,
      title: track.title,
      artist: track.artists.joined(separator: " / "),
      album: track.album,
      hasCover: track.hasCover,
      streamPath: "api/v1/tracks/\(track.id)/stream",
      unavailableReason: track.unavailableReason
    )
  }

  static func play(_ tracks: [Track], startingAt track: Track, playback: PlaybackService) {
    guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
    playback.play(items: tracks.map(item), startingAt: index)
  }
}

struct MacPlayableTracks: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  let tracks: [Track]
  var emptyTitle: String
  var emptyDetail: String?
  var emptyIcon: String = "music.note"
  var canManage = false
  var playlist: Playlist?
  var onReload: (@MainActor () async -> Void)?
  var isLoading = false
  var allowsSelection = false
  var externalSelecting: Binding<Bool>?
  var trackBadge: ((Track) -> String?)?
  var trackReason: ((Track) -> String?)?
  var onRecommendationFeedback: ((Track, String) async -> Void)?
  @Environment(\.navigateToTrackCollection) private var navigate

  @State private var selecting = false
  @State private var selected: Set<String> = []
  @State private var playlistSelection: MacPlaylistSelection?
  @State private var lyricTrack: Track?
  @State private var editing: Track?
  @State private var notice: String?
  @State private var hoveredTrackID: String?

  private var isSelecting: Bool {
    externalSelecting?.wrappedValue ?? selecting
  }

  private func setSelecting(_ value: Bool) {
    selecting = value
    externalSelecting?.wrappedValue = value
  }

  var body: some View {
    GeometryReader { geometry in
      let wide = geometry.size.width >= 680
      let artistWidth = (geometry.size.width - 36) * 0.21
      let albumWidth = (geometry.size.width - 36) * 0.24
      VStack(spacing: 0) {
        if wide {
          HStack(spacing: 16) {
            if isSelecting { Color.clear.frame(width: 18, height: 1) }
            Text("#").frame(width: 28, alignment: .trailing)
            Text(L10n("macCatalog.trackTitle"))
              .padding(.leading, 52)
              .frame(maxWidth: .infinity, alignment: .leading)
            Text(L10n("macCatalog.artist")).frame(width: artistWidth, alignment: .leading)
            Text(L10n("macCatalog.album")).frame(width: albumWidth, alignment: .leading)
            Color.clear.frame(width: 32, height: 1)
            Text(L10n("macCatalog.duration")).frame(width: 48, alignment: .trailing)
            Color.clear.frame(width: 26, height: 1)
          }
          .font(MacTheme.micro)
          .foregroundStyle(MacTheme.faint)
          .padding(.horizontal, 30)
          .padding(.vertical, 10)
          .overlay(alignment: .bottom) {
            Rectangle().fill(MacTheme.border).frame(height: 1)
          }
        }
        List {
          ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
            trackRow(
              track, number: index + 1, wide: wide,
              artistWidth: artistWidth, albumWidth: albumWidth
            )
            .listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(MacTheme.canvas)
      }
    }
    .overlay {
      if tracks.isEmpty {
        if isLoading {
          ProgressView()
        } else if let emptyDetail {
          ContentUnavailableView(emptyTitle, systemImage: emptyIcon, description: Text(emptyDetail))
        } else {
          ContentUnavailableView(emptyTitle, systemImage: emptyIcon)
        }
      }
    }
    .overlay(alignment: .bottom) {
      if let notice {
        Text(notice)
          .font(.callout)
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(.regularMaterial, in: Capsule())
          .padding(.bottom, 12)
      }
    }
    .sheet(item: $editing) { track in
      MacMetadataSheet(client: client, track: track)
    }
    .sheet(item: $playlistSelection) { selection in
      MacAddToPlaylistSheet(client: client, tracks: selection.tracks) { message in
        notice = message
        selected = []
        setSelecting(false)
        scheduleNoticeClear()
      }
    }
    .sheet(item: $lyricTrack) { track in MacLyricsPreview(client: client, track: track) }
    .safeAreaInset(edge: .top, spacing: 0) {
      if allowsSelection && (isSelecting || externalSelecting == nil) {
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text(isSelecting ? L10n("macCatalog.selectedCount", selectedTracks.count) : L10n("macCatalog.selectPrompt"))
              .font(MacTheme.caption).foregroundStyle(MacTheme.muted)
            Spacer()
            if isSelecting {
              HStack(spacing: 8) {
                Button(selectedTracks.count == tracks.count ? L10n("macCatalog.deselectAll") : L10n("macCatalog.selectAll")) {
                  selected = selectedTracks.count == tracks.count ? [] : Set(tracks.map(\.id))
                }
                Button(L10n("macCatalog.playSelectedNext")) { enqueue(selectedTracks, next: true) }
                  .disabled(selectedTracks.isEmpty)
                Button(L10n("macCatalog.addToQueue")) { enqueue(selectedTracks) }
                  .disabled(selectedTracks.isEmpty)
                Button(L10n("macCatalog.addToPlaylistEllipsis")) { playlistSelection = MacPlaylistSelection(tracks: selectedTracks) }
                  .disabled(selectedTracks.isEmpty)
              }.controlSize(.small)
            }
            Button(isSelecting ? L10n("macCatalog.doneSelecting") : L10n("macCatalog.selectTracks")) {
              setSelecting(!isSelecting)
              selected = []
            }
            .controlSize(.small)
            .disabled(tracks.isEmpty && !isSelecting)
          }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 10)
        .background(MacTheme.panel)
        .overlay(alignment: .bottom) {
          Rectangle().fill(MacTheme.border).frame(height: 1)
        }
      }
    }
    .onChange(of: tracks.map(\.id)) { _, ids in selected.formIntersection(Set(ids)) }
  }

  private func trackRow(
    _ track: Track,
    number: Int,
    wide: Bool,
    artistWidth: CGFloat,
    albumWidth: CGFloat
  ) -> some View {
    let current = playback.currentItem?.trackID == track.id
    let numberText = trackBadge?(track) ?? String(format: "%02d", number)
    let reason = trackReason?(track)?.trimmingCharacters(in: .whitespacesAndNewlines)
    let isHovered = hoveredTrackID == track.id
    let coverTrackID: String? = track.hasCover
      ? track.id
      : (tracks.first(where: \.hasCover)?.id ?? (tracks.first?.album != nil ? tracks.first?.id : nil))
    return HStack(spacing: 16) {
      if isSelecting {
        Toggle(L10n("macCatalog.selectTrack", track.title), isOn: Binding(
          get: { selected.contains(track.id) },
          set: { if $0 { selected.insert(track.id) } else { selected.remove(track.id) } }
        )).toggleStyle(.checkbox).labelsHidden().frame(width: 18)
      }
      if wide {
        Text(numberText)
          .font(MacTheme.mono(12))
          .foregroundStyle(current ? MacTheme.accentDeep : MacTheme.faint)
          .frame(width: 28, alignment: .trailing)
      } else if let badge = trackBadge?(track) {
        Text(badge)
          .font(MacTheme.mono(12))
          .foregroundStyle(current ? MacTheme.accentDeep : MacTheme.faint)
          .frame(width: 28, alignment: .trailing)
      }
      HStack(spacing: 10) {
        Button {
          if isSelecting {
            if selected.contains(track.id) { selected.remove(track.id) }
            else { selected.insert(track.id) }
          } else {
            MacPlayback.play(tracks, startingAt: track, playback: playback)
          }
        } label: {
          MacCover(client: client, trackID: coverTrackID, side: 42)
        }
        .buttonStyle(.plain)
        .help(L10n("macCatalog.playTrack", track.title))

        VStack(alignment: .leading, spacing: 3) {
          Button {
            if isSelecting {
              if selected.contains(track.id) { selected.remove(track.id) }
              else { selected.insert(track.id) }
            } else {
              MacPlayback.play(tracks, startingAt: track, playback: playback)
            }
          } label: {
            Text(track.title)
              .font(.system(size: 13, weight: current ? .semibold : .medium))
              .foregroundStyle(!track.isAvailable ? MacTheme.muted : current ? MacTheme.accentDeep : MacTheme.ink)
              .lineLimit(1)
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)

          if let reason = track.unavailableReason {
            Label(reason, systemImage: "exclamationmark.circle")
              .font(MacTheme.caption).foregroundStyle(MacTheme.muted)
              .help(L10n("macCatalog.restoreFileHelp"))
          } else if current {
            Text(playback.isPlaying ? L10n("macCatalog.nowPlaying") : L10n("macCatalog.paused"))
              .font(.system(size: 11))
              .foregroundStyle(MacTheme.accentDeep)
              .lineLimit(1)
          } else if !wide {
            HStack(spacing: 4) {
              artistLink(track)
              if track.albumId != nil || !(track.album ?? "").isEmpty {
                Text("·").foregroundStyle(MacTheme.faint)
                albumLink(track)
              }
            }
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.muted)
            .lineLimit(1)
          }

          if let reason, !reason.isEmpty {
            Text(reason)
              .font(.system(size: 11))
              .foregroundStyle(MacTheme.olive)
              .lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if wide {
        artistLink(track)
          .font(MacTheme.caption)
          .frame(width: artistWidth, alignment: .leading)
        albumLink(track)
          .font(MacTheme.caption)
          .frame(width: albumWidth, alignment: .leading)
      }

      HStack(spacing: 5) {
        if favorites?.isFavorite(track.id) == true {
          Image(systemName: "heart.fill")
        }
        if current {
          Image(systemName: playback.isPlaying ? "speaker.wave.2.fill" : "pause.fill")
        }
      }
      .font(.caption)
      .foregroundStyle(MacTheme.accentDeep)
      .frame(width: 32, alignment: .trailing)

      Text(macClock(milliseconds: track.durationMs))
        .font(MacTheme.mono())
        .foregroundStyle(current ? MacTheme.accentDeep : MacTheme.faint)
        .frame(width: 48, alignment: .trailing)

      Menu { trackMenu(track) } label: {
        Image(systemName: "ellipsis").frame(width: 26, height: 28).contentShape(Rectangle())
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
      .accessibilityLabel(L10n("macCatalog.moreActionsForTrack", track.title))
      .help(L10n("macCatalog.moreActionsForTrack", track.title))
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(
      current ? MacTheme.accentSoft : (isHovered ? MacTheme.hover : MacTheme.panel),
      in: RoundedRectangle(cornerRadius: MacTheme.rowRadius, style: .continuous)
    )
    .overlay {
      RoundedRectangle(cornerRadius: MacTheme.rowRadius, style: .continuous)
        .strokeBorder(current ? MacTheme.accent.opacity(0.45) : MacTheme.border, lineWidth: 1)
    }
    .padding(.vertical, 3)
    .overlay(alignment: .leading) {
      if current {
        Capsule()
          .fill(MacTheme.accent)
          .frame(width: 3)
          .padding(.horizontal, 3)
          .padding(.vertical, 12)
      }
    }
    .onHover { hovering in
      guard !isSelecting else { return }
      if hovering {
        hoveredTrackID = track.id
      } else if hoveredTrackID == track.id {
        hoveredTrackID = nil
      }
    }
    .contextMenu { trackMenu(track) }
  }

  @ViewBuilder
  private func artistLink(_ track: Track) -> some View {
    if track.artists.count == 1, let name = track.artists.first {
      Button { navigate(.artist(name: name)) } label: {
        Text(name).lineLimit(1)
      }.buttonStyle(.plain).foregroundStyle(MacTheme.muted).help(L10n("macCatalog.viewArtist", name))
    } else if track.artists.count > 1 {
      Menu {
        ForEach(track.artists, id: \.self) { name in
          Button(name) { navigate(.artist(name: name)) }
        }
      } label: {
        Text(track.artists.joined(separator: " / ")).lineLimit(1)
      }.menuStyle(.borderlessButton).menuIndicator(.hidden)
        .foregroundStyle(MacTheme.muted).help(L10n("macCatalog.selectArtistHelp"))
    } else {
      Text("—").foregroundStyle(MacTheme.faint)
    }
  }

  @ViewBuilder
  private func albumLink(_ track: Track) -> some View {
    if let id = track.albumId, let title = track.album, !title.isEmpty {
      Button { navigate(.album(id: id, title: title)) } label: {
        Text(title).lineLimit(1)
      }.buttonStyle(.plain).foregroundStyle(MacTheme.muted).help(L10n("macCatalog.viewAlbumWithTitle", title))
    } else if let title = track.album, !title.isEmpty {
      Text(title).lineLimit(1).foregroundStyle(MacTheme.muted)
    } else {
      Text("—").foregroundStyle(MacTheme.faint)
    }
  }

  private var selectedTracks: [Track] { tracks.filter { selected.contains($0.id) } }

  private func enqueue(_ tracks: [Track], next: Bool = false) {
    if playback.enqueue(items: tracks.map(MacPlayback.item), next: next) {
      notice = next ? L10n("macCatalog.enqueuedSelectedNext", tracks.count) : L10n("macCatalog.enqueuedSelected", tracks.count)
      selected = []
      setSelecting(false)
    } else {
      notice = playback.errorMessage
    }
    scheduleNoticeClear()
  }

  @ViewBuilder
  private func trackMenu(_ track: Track) -> some View {
    Button(L10n("macCatalog.playNext")) { enqueue([track], next: true) }
    Button(L10n("macCatalog.addToQueue")) { enqueue([track]) }
    Button(L10n("macCatalog.addToPlaylistEllipsis")) { playlistSelection = MacPlaylistSelection(tracks: [track]) }
    Button(L10n("macCatalog.viewLyrics")) { lyricTrack = track }
    if let id = track.albumId, let title = track.album {
      Button(L10n("macCatalog.viewAlbum")) { navigate(.album(id: id, title: title)) }
    }
    ForEach(track.artists, id: \.self) { name in
      Button(L10n("macCatalog.viewArtist", name)) { navigate(.artist(name: name)) }
    }
    Divider()
    if let favorites {
      Button(favorites.isFavorite(track.id) ? L10n("macCatalog.unfavorite") : L10n("macCatalog.favorite")) {
        Task { await favorites.toggle(track.id) }
      }
    }
    if let playlist, playlist.isEditable {
      Button(L10n("macCatalog.removeFromPlaylist"), role: .destructive) {
        Task { await remove(track, from: playlist) }
      }
    }
    if canManage {
      Button(L10n("macCatalog.editMetadata")) { editing = track }
    }
    if let onRecommendationFeedback {
      Divider()
      Button(L10n("macCatalog.notInterested")) { Task { await onRecommendationFeedback(track, "dismiss_track") } }
      Button(L10n("macCatalog.recommendLessArtist")) { Task { await onRecommendationFeedback(track, "less_artist") } }
    }
  }

  private func remove(_ track: Track, from playlist: Playlist) async {
    do {
      let fresh = try await client.playlist(id: playlist.id)
      try await client.removeTrack(playlistID: fresh.id, trackID: track.id, version: fresh.version)
      notice = L10n("macCatalog.removedFromPlaylist", fresh.name)
      await onReload?()
    } catch {
      notice = MacErrorText.message(for: error)
    }
    scheduleNoticeClear()
  }

  private func scheduleNoticeClear() {
    Task {
      try? await Task.sleep(for: .seconds(2))
      notice = nil
    }
  }
}

struct MacAlbumsView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  var canManage = false

  @State private var query = ""
  @State private var albums: [Album] = []
  @State private var total = 0
  @State private var message: String?
  @State private var loading = true
  @FocusState private var searchFocused: Bool

  private var columns: [GridItem] {
    [GridItem(.adaptive(minimum: 168, maximum: 210), spacing: 18)]
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 0) {
        MacSearchField(placeholder: L10n("macCatalog.searchAlbums"), text: $query, focused: $searchFocused)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 24)
      .padding(.top, 12)
      .padding(.bottom, 6)
      ScrollView {
        LazyVGrid(columns: columns, spacing: 22) {
          ForEach(albums) { album in
            MacCatalogCard(
              client: client,
              value: album,
              title: album.title,
              subtitle: album.artists.joined(separator: " / "),
              cover: album.coverTrackId
            )
          }
        }
        .padding(24)
      }
      if albums.count < total {
        MacLoadMoreBar(text: L10n("macCatalog.remainingAlbums", total - albums.count)) {
          Task { await load(reset: false) }
        }
      }
    }
    .navigationTitle(L10n("macCatalog.albums"))
    .navigationDestination(for: Album.self) { album in
      MacAlbumDetail(
        client: client,
        playback: playback,
        favorites: favorites,
        album: album,
        canManage: canManage
      )
    }
    .overlay {
      if albums.isEmpty {
        if loading {
          ProgressView()
        } else if let message {
          ContentUnavailableView(L10n("macCatalog.cannotLoadAlbums"), systemImage: "square.stack", description: Text(message))
        } else {
          ContentUnavailableView(L10n("macCatalog.noMatchingAlbums"), systemImage: "square.stack")
        }
      }
    }
    .task(id: query) { await load(reset: true) }
  }

  private func load(reset: Bool) async {
    if reset { loading = albums.isEmpty }
    do {
      let text = query.trimmingCharacters(in: .whitespaces)
      if reset, !text.isEmpty {
        try await Task.sleep(for: .milliseconds(280))
        guard !Task.isCancelled else { return }
      }
      let page = try await client.albums(
        limit: 100,
        offset: reset ? 0 : albums.count,
        query: text.isEmpty ? nil : text
      )
      guard !Task.isCancelled else { return }
      albums = reset ? page.items : albums + page.items
      total = page.total
      message = nil
    } catch is CancellationError {
      return
    } catch {
      if reset { albums = [] }
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

private struct MacAlbumDetail: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  let album: Album
  var canManage = false
  @Environment(\.dismiss) private var dismiss

  @State private var tracks: [Track] = []
  @State private var message: String?
  @State private var loading = true

  var body: some View {
    VStack(spacing: 0) {
      MacCollectionHeading(
        title: album.title,
        subtitle: L10n("macCatalog.trackCount", album.trackCount),
        symbol: "square.stack",
        canPlay: !tracks.isEmpty,
        coverTrackID: album.coverTrackId,
        client: client,
        onBack: { dismiss() }
      ) {
        guard let first = tracks.first(where: \.isAvailable) ?? tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
      MacPlayableTracks(
        client: client,
        playback: playback,
        favorites: favorites,
        tracks: tracks,
        emptyTitle: message == nil ? L10n("macCatalog.albumEmpty") : L10n("macCatalog.cannotLoadAlbums"),
        emptyDetail: message,
        canManage: canManage,
        isLoading: loading
      )
    }
    .navigationTitle(album.title)
    .navigationBarBackButtonHidden(true)
    .toolbar {
      ToolbarItem(placement: .navigation) {
        Button {
          dismiss()
        } label: {
          Image(systemName: "chevron.backward")
        }
        .help(L10n("macCatalog.back"))
        .keyboardShortcut("[", modifiers: .command)
      }
    }
    .task { await load() }
  }

  private func load() async {
    loading = tracks.isEmpty
    do {
      tracks = try await MacPages.albumTracks(client: client, albumId: album.id)
      message = nil
    } catch {
      tracks = []
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

struct MacArtistsView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  var canManage = false

  @State private var query = ""
  @State private var artists: [Artist] = []
  @State private var total = 0
  @State private var message: String?
  @State private var loading = true
  @FocusState private var searchFocused: Bool
    @AppStorage("macArtistRole") private var role = "album_artist"

  private var columns: [GridItem] {
    [GridItem(.adaptive(minimum: 168, maximum: 210), spacing: 18)]
  }
  private var roleLabel: String {
    switch role {
    case "artist": return L10n("macCatalog.roleArtist")
    case "": return L10n("macCatalog.roleAll")
    case "vocalist": return L10n("macCatalog.roleVocalist")
    case "lyricist": return L10n("macCatalog.roleLyricist")
    case "composer": return L10n("macCatalog.roleComposer")
    case "arranger": return L10n("macCatalog.roleArranger")
    default: return L10n("macCatalog.roleAlbumArtist")
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 0) {
        MacSearchField(placeholder: L10n("macCatalog.searchArtists"), text: $query, focused: $searchFocused)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 24)
      .padding(.top, 12)
      .padding(.bottom, 6)
      ScrollView {
        LazyVGrid(columns: columns, spacing: 22) {
          ForEach(artists) { artist in
            MacCatalogCard(
              client: client,
              value: artist,
              title: artist.name,
              subtitle: L10n("macCatalog.artistSubtitle", artist.albumCount, artist.trackCount),
              cover: artist.coverTrackId
            )
          }
        }
        .padding(24)
      }
      if artists.count < total {
        MacLoadMoreBar(text: L10n("macCatalog.remainingArtists", total - artists.count)) {
          Task { await load(reset: false) }
        }
      }
    }
    .navigationTitle(L10n("macCatalog.artists"))
    .toolbar {
      QuietToolbarItem {
        Menu {
          Picker(L10n("macCatalog.rolePicker"), selection: $role) {
          Text(L10n("macCatalog.roleArtist")).tag("artist")
          Text(L10n("macCatalog.roleAlbumArtist")).tag("album_artist")
          Text(L10n("macCatalog.roleAll")).tag("")
          Divider()
          Text(L10n("macCatalog.roleVocalist")).tag("vocalist")
          Text(L10n("macCatalog.roleLyricist")).tag("lyricist")
          Text(L10n("macCatalog.roleComposer")).tag("composer")
          Text(L10n("macCatalog.roleArranger")).tag("arranger")
        }
        .pickerStyle(.inline)
        .labelsHidden()
      } label: {
        HStack(spacing: 5) {
          Text(roleLabel)
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.ink)
          Image(systemName: "chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(MacTheme.muted)
        }
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
      .help(L10n("macCatalog.roleFilterHelp"))
      .accessibilityLabel(L10n("macCatalog.roleFilterHelp"))
      }
    }
    .navigationDestination(for: Artist.self) { artist in
      if role == "album_artist" {
        MacArtistAlbumsDetail(
          client: client,
          playback: playback,
          favorites: favorites,
          artist: artist,
          canManage: canManage
        )
      } else {
        MacArtistDetail(
          client: client,
          playback: playback,
          favorites: favorites,
          artist: artist,
          canManage: canManage
        )
      }
    }
    .overlay {
      if artists.isEmpty {
        if loading {
          ProgressView()
        } else if let message {
          ContentUnavailableView(L10n("macCatalog.cannotLoadArtists"), systemImage: "person.2", description: Text(message))
        } else {
          ContentUnavailableView(L10n("macCatalog.noMatchingArtists"), systemImage: "person.2")
        }
      }
    }
    .task(id: "\(role)|\(query)") { await load(reset: true) }
  }

  private func load(reset: Bool) async {
    if reset { loading = artists.isEmpty }
    do {
      let text = query.trimmingCharacters(in: .whitespaces)
      if reset, !text.isEmpty {
        try await Task.sleep(for: .milliseconds(280))
        guard !Task.isCancelled else { return }
      }
      let page = try await client.artists(
        limit: 100,
        offset: reset ? 0 : artists.count,
        query: text.isEmpty ? nil : text,
        role: role.isEmpty ? nil : role
      )
      guard !Task.isCancelled else { return }
      artists = reset ? page.items : artists + page.items
      total = page.total
      message = nil
    } catch is CancellationError {
      return
    } catch {
      if reset { artists = [] }
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

private struct MacArtistDetail: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  let artist: Artist
  var canManage = false
  @Environment(\.dismiss) private var dismiss

  @State private var tracks: [Track] = []
  @State private var message: String?
  @State private var loading = true

  var body: some View {
    VStack(spacing: 0) {
      MacCollectionHeading(
        title: artist.name,
        subtitle: L10n("macCatalog.trackCount", artist.trackCount),
        symbol: "person.2",
        canPlay: !tracks.isEmpty,
        coverTrackID: artist.coverTrackId,
        client: client,
        onBack: { dismiss() }
      ) {
        guard let first = tracks.first(where: \.isAvailable) ?? tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
      MacPlayableTracks(
        client: client,
        playback: playback,
        favorites: favorites,
        tracks: tracks,
        emptyTitle: message == nil ? L10n("macCatalog.artistEmpty") : L10n("macCatalog.cannotLoadArtists"),
        emptyDetail: message,
        canManage: canManage,
        isLoading: loading
      )
    }
    .navigationTitle(artist.name)
    .navigationBarBackButtonHidden(true)
    .toolbar {
      ToolbarItem(placement: .navigation) {
        Button {
          dismiss()
        } label: {
          Image(systemName: "chevron.backward")
        }
        .help(L10n("macCatalog.back"))
        .keyboardShortcut("[", modifiers: .command)
      }
    }
    .task { await load() }
  }

  private func load() async {
    loading = tracks.isEmpty
    do {
      tracks = try await MacPages.artistTracks(client: client, artistId: artist.id)
      message = nil
    } catch {
      tracks = []
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}


private struct MacArtistAlbumsDetail: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  let artist: Artist
  var canManage = false
  @Environment(\.dismiss) private var dismiss

  @State private var albums: [Album] = []
  @State private var message: String?
  @State private var loading = true

  private var columns: [GridItem] {
    [GridItem(.adaptive(minimum: 168, maximum: 210), spacing: 18)]
  }

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        LazyVGrid(columns: columns, spacing: 22) {
          ForEach(albums) { album in
            MacCatalogCard(
              client: client,
              value: album,
              title: album.title,
              subtitle: album.artists.joined(separator: " / "),
              cover: album.coverTrackId
            )
          }
        }
        .padding(24)
      }
    }
    .navigationTitle(artist.name)
    .navigationBarBackButtonHidden(true)
    .toolbar {
      ToolbarItem(placement: .navigation) {
        Button {
          dismiss()
        } label: {
          Image(systemName: "chevron.backward")
        }
        .help(L10n("macCatalog.back"))
        .keyboardShortcut("[", modifiers: .command)
      }
    }
    .navigationDestination(for: Album.self) { album in
      MacAlbumDetail(
        client: client,
        playback: playback,
        favorites: favorites,
        album: album,
        canManage: canManage
      )
    }
    .overlay {
      if albums.isEmpty {
        if loading {
          ProgressView()
        } else if let message {
          ContentUnavailableView(L10n("macCatalog.cannotLoadAlbums"), systemImage: "square.stack", description: Text(message))
        } else {
          ContentUnavailableView(L10n("macCatalog.artistAlbumsEmpty"), systemImage: "square.stack")
        }
      }
    }
    .task { await load() }
  }

  private func load() async {
    loading = albums.isEmpty
    do {
      albums = try await MacPages.collect { offset in
        try await client.artistAlbums(artistId: artist.id, limit: 100, offset: offset)
      }
      message = nil
    } catch {
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

struct MacPlaylistsView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  var canManage = false

  @State private var playlists: [Playlist] = []
  @State private var message: String?
  @State private var failure: String?
  @State private var creating = false
  @State private var renaming: Playlist?
  @State private var renameText = ""
  @State private var loading = true

  private var columns: [GridItem] {
    [GridItem(.adaptive(minimum: 168, maximum: 210), spacing: 18)]
  }

  private var manuals: [Playlist] { playlists.filter { !$0.isFavorites } }

  var body: some View {
    ScrollView {
      LazyVGrid(columns: columns, spacing: 22) {
        ForEach(manuals) { playlist in
          MacCatalogCard(
            client: client,
            value: playlist,
            title: playlist.name,
            subtitle: L10n("macCatalog.trackCount", playlist.trackCount),
            cover: playlist.coverTrackId
          )
          .contextMenu {
            if playlist.isEditable {
              Button(L10n("macCatalog.rename")) {
                renameText = playlist.name
                renaming = playlist
              }
              Button(L10n("macCatalog.delete"), role: .destructive) { Task { await delete(playlist) } }
            }
          }
        }
      }
      .padding(24)
    }
    .navigationTitle(L10n("macCatalog.playlists"))
    .toolbar {
      QuietToolbarItem {
        MacToolbarTextButton(title: L10n("macCatalog.newPlaylist"), systemImage: "plus", accent: true) { creating = true }
      }
    }
    .navigationDestination(for: Playlist.self) { playlist in
      MacPlaylistDetail(
        client: client,
        playback: playback,
        favorites: favorites,
        playlist: playlist,
        canManage: canManage
      )
    }
    .overlay {
      if manuals.isEmpty {
        if loading {
          ProgressView()
        } else if let message {
          ContentUnavailableView(
            L10n("macCatalog.cannotLoadPlaylists"), systemImage: "music.note.list", description: Text(message))
        } else {
          ContentUnavailableView(L10n("macCatalog.noPlaylists"), systemImage: "music.note.list")
        }
      }
    }
    .sheet(isPresented: $creating) {
      MacPlaylistCreationSheet(client: client, onSaved: { await load() })
    }
    .alert(
      L10n("macCatalog.renamePlaylist"),
      isPresented: Binding(
        get: { renaming != nil },
        set: { if !$0 { renaming = nil } }
      )
    ) {
      TextField(L10n("macCatalog.playlistNamePlaceholder"), text: $renameText)
      Button(L10n("macCatalog.save")) { Task { await rename() } }
      Button(L10n("macCatalog.cancel"), role: .cancel) { renaming = nil }
    }
    .alert(
      L10n("macCatalog.actionIncomplete"),
      isPresented: Binding(
        get: { failure != nil },
        set: { if !$0 { failure = nil } }
      )
    ) {
      Button(L10n("macCatalog.ok")) { failure = nil }
    } message: {
      Text(failure ?? "")
    }
    .task { await load() }
  }

  private func load() async {
    loading = playlists.isEmpty
    do {
      playlists = try await MacPages.playlists(client: client)
      message = nil
    } catch {
      message = MacErrorText.message(for: error)
    }
    loading = false
  }

  private func rename() async {
    guard let playlist = renaming else { return }
    renaming = nil
    let name = renameText.trimmingCharacters(in: .whitespaces)
    guard !name.isEmpty else { return }
    do {
      let fresh = try await client.playlist(id: playlist.id)
      _ = try await client.renamePlaylist(
        id: fresh.id, name: name, version: fresh.version, kind: fresh.kind)
      await load()
    } catch {
      failure = MacErrorText.message(for: error)
    }
  }

  private func delete(_ playlist: Playlist) async {
    do {
      let fresh = try await client.playlist(id: playlist.id)
      try await client.deletePlaylist(playlistID: fresh.id, version: fresh.version)
      await load()
    } catch {
      failure = MacErrorText.message(for: error)
    }
  }
}


private struct MacPlaylistCreationSheet: View {
  let client: WildstringClient
  let onSaved: () async -> Void
  @Environment(\.dismiss) private var dismiss

  @State private var name = ""
  @State private var kind = "manual"
  @State private var match = "all"
  @State private var rows: [Row] = [Row()]
  @State private var sort = "title"
  @State private var order = "asc"
  @State private var limit = 200
  @State private var creating = false
  @State private var error: String?

  private struct Row: Identifiable {
    let id = UUID()
    var field = "artist"
    var oper = "contains"
    var value = ""
    var end = ""
  }

  private enum FieldType { case text, number, boolean, date }

  private static let fieldMeta: [(id: String, labelKey: String, type: FieldType)] = [
    ("title", "macCatalog.smartFieldTitle", .text),
    ("artist", "macCatalog.smartFieldArtist", .text),
    ("albumartist", "macCatalog.smartFieldAlbumArtist", .text),
    ("album", "macCatalog.smartFieldAlbum", .text),
    ("filetype", "macCatalog.smartFieldFormat", .text),
    ("duration", "macCatalog.smartFieldDuration", .number),
    ("loved", "macCatalog.smartFieldLoved", .boolean),
    ("playCount", "macCatalog.smartFieldPlayCount", .number),
    ("listened", "macCatalog.smartFieldListened", .number),
    ("lastPlayed", "macCatalog.smartFieldLastPlayed", .date),
    ("dateAdded", "macCatalog.smartFieldDateAdded", .date),
    ("dateLoved", "macCatalog.smartFieldDateLoved", .date),
  ]

  private static let sortMeta: [(id: String, labelKey: String)] = [
    ("title", "macCatalog.smartFieldTitle"),
    ("artist", "macCatalog.smartFieldArtist"),
    ("album", "macCatalog.smartFieldAlbum"),
    ("duration", "macCatalog.smartFieldDuration"),
    ("playCount", "macCatalog.smartFieldPlayCount"),
    ("listened", "macCatalog.smartFieldListened"),
    ("lastPlayed", "macCatalog.smartFieldLastPlayed"),
    ("dateAdded", "macCatalog.smartFieldDateAdded"),
    ("dateLoved", "macCatalog.smartFieldDateLoved"),
  ]

  private static func fieldType(of field: String) -> FieldType {
    fieldMeta.first { $0.id == field }?.type ?? .text
  }

  private static func operators(for field: String) -> [String] {
    switch fieldType(of: field) {
    case .boolean: return ["is"]
    case .number: return ["gt", "lt", "is", "inTheRange"]
    case .date: return ["inTheLast", "notInTheLast"]
    case .text: return ["contains", "is", "isNot", "notContains", "startsWith", "endsWith"]
    }
  }

  private static func operatorLabel(_ op: String) -> String {
    switch op {
    case "is": return L10n("macCatalog.smartOpIs")
    case "isNot": return L10n("macCatalog.smartOpIsNot")
    case "contains": return L10n("macCatalog.smartOpContains")
    case "notContains": return L10n("macCatalog.smartOpNotContains")
    case "startsWith": return L10n("macCatalog.smartOpStartsWith")
    case "endsWith": return L10n("macCatalog.smartOpEndsWith")
    case "gt": return L10n("macCatalog.smartOpGt")
    case "lt": return L10n("macCatalog.smartOpLt")
    case "inTheRange": return L10n("macCatalog.smartOpInTheRange")
    case "inTheLast": return L10n("macCatalog.smartOpInTheLast")
    case "notInTheLast": return L10n("macCatalog.smartOpNotInTheLast")
    default: return op
    }
  }

  private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

  private func ruleIsValid(_ row: Row) -> Bool {
    switch Self.fieldType(of: row.field) {
    case .boolean:
      return row.value == "true" || row.value == "false"
    case .number:
      guard let low = Double(row.value) else { return false }
      if row.oper == "inTheRange" {
        guard let high = Double(row.end) else { return false }
        return low <= high
      }
      return true
    case .date:
      guard let days = Int(row.value) else { return false }
      return days >= 1 && days <= 36500
    case .text:
      return !row.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }

  private var canCreate: Bool {
    guard !trimmedName.isEmpty else { return false }
    guard kind == "smart" else { return true }
    return !rows.isEmpty && rows.allSatisfy(ruleIsValid)
  }

  private func makeDefinition() -> SmartDefinition {
    let rules = rows.map { row -> SmartRule in
      let value: SmartValue
      switch Self.fieldType(of: row.field) {
      case .boolean:
        value = .bool(row.value == "true")
      case .number, .date:
        if row.oper == "inTheRange" {
          value = .numbers([Double(row.value) ?? 0, Double(row.end) ?? 0])
        } else {
          value = .number(Double(row.value) ?? 0)
        }
      case .text:
        value = .string(row.value)
      }
      return SmartRule(operator: row.oper, field: row.field, value: value)
    }
    return SmartDefinition(match: match, rules: rules, sort: sort, order: order, limit: limit)
  }

  var body: some View {
    VStack(spacing: 0) {
      Text(L10n("macCatalog.newPlaylist"))
        .font(.title2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding([.horizontal, .top], 20)
        .padding(.bottom, 4)
      Form {
        Section {
          TextField(L10n("macCatalog.playlistNamePlaceholder"), text: $name)
            .textFieldStyle(.roundedBorder)
        }
        Section {
          Picker(L10n("macCatalog.smartKindLabel"), selection: $kind) {
            Text(L10n("macCatalog.playlistKindManual")).tag("manual")
            Text(L10n("macCatalog.playlistKindSmart")).tag("smart")
          }
          .pickerStyle(.segmented)
          .labelsHidden()
        }
        if kind == "smart" {
          Section {
            Picker(L10n("macCatalog.smartMatchLabel"), selection: $match) {
              Text(L10n("macCatalog.smartMatchAll")).tag("all")
              Text(L10n("macCatalog.smartMatchAny")).tag("any")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            ForEach($rows) { $row in
              ruleRow($row)
            }
            Button {
              withAnimation(.easeInOut(duration: 0.18)) { rows.append(Row()) }
            } label: {
              Label(L10n("macCatalog.smartAddRule"), systemImage: "plus")
            }
            .buttonStyle(.borderless)
          } header: {
            Text(L10n("macCatalog.smartRulesLegend"))
          } footer: {
            Text(L10n("macCatalog.smartHint"))
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Section {
            Picker(L10n("macCatalog.smartSortLabel"), selection: $sort) {
              ForEach(Self.sortMeta, id: \.id) { meta in
                Text(L10n(meta.labelKey)).tag(meta.id)
              }
            }
            Picker(L10n("macCatalog.smartOrderLabel"), selection: $order) {
              Text(L10n("macCatalog.smartOrderAsc")).tag("asc")
              Text(L10n("macCatalog.smartOrderDesc")).tag("desc")
            }
            .pickerStyle(.segmented)
            Stepper(value: $limit, in: 1 ... 5000, step: 50) {
              Text(L10n("macCatalog.smartLimit", limit))
            }
          } header: {
            Text(L10n("macCatalog.smartSortSection"))
          }
        }
      }
      .formStyle(.grouped)
      Divider()
      HStack {
        if let error {
          Text(error).font(.caption).foregroundStyle(.red).lineLimit(2)
        }
        Spacer(minLength: 8)
        Button(L10n("macCatalog.cancel")) { dismiss() }
          .buttonStyle(.bordered)
        Button(L10n("macCatalog.create")) { save() }
          .buttonStyle(.borderedProminent)
          .tint(MacTheme.accentDeep)
          .disabled(!canCreate || creating)
      }
      .padding([.horizontal, .bottom], 16)
      .padding(.top, 8)
    }
    .frame(width: 620)
    .frame(minHeight: 420, maxHeight: 680)
  }

  private func save() {
    creating = true
    error = nil
    Task {
      do {
        let definition = kind == "smart" ? makeDefinition() : nil
        _ = try await client.createPlaylist(name: trimmedName, kind: kind, definition: definition)
        await onSaved()
        dismiss()
      } catch {
        self.error = MacErrorText.message(for: error)
        creating = false
      }
    }
  }

  @ViewBuilder private func ruleRow(_ row: Binding<Row>) -> some View {
    HStack(spacing: 8) {
      Picker("", selection: Binding(get: { row.wrappedValue.field }, set: { newValue in
        row.wrappedValue.field = newValue
        let allowed = Self.operators(for: newValue)
        if !allowed.contains(row.wrappedValue.oper) { row.wrappedValue.oper = allowed[0] }
        if Self.fieldType(of: newValue) == .boolean { row.wrappedValue.value = "true" }
      })) {
        ForEach(Self.fieldMeta, id: \.id) { meta in
          Text(L10n(meta.labelKey)).tag(meta.id)
        }
      }
      .labelsHidden()
      .frame(width: 140)
      Picker("", selection: row.oper) {
        ForEach(Self.operators(for: row.wrappedValue.field), id: \.self) { op in
          Text(Self.operatorLabel(op)).tag(op)
        }
      }
      .labelsHidden()
      .frame(width: 122)
      valueControl(row)
      Button {
        rows.removeAll { $0.id == row.wrappedValue.id }
      } label: {
        Image(systemName: "minus.circle.fill")
          .font(.system(size: 16))
          .foregroundStyle(rows.count > 1 ? MacTheme.muted : MacTheme.border)
      }
      .buttonStyle(.plain)
      .disabled(rows.count <= 1)
      .help(L10n("macCatalog.delete"))
      .accessibilityLabel(L10n("macCatalog.delete"))
    }
  }

  @ViewBuilder private func valueControl(_ row: Binding<Row>) -> some View {
    switch Self.fieldType(of: row.wrappedValue.field) {
    case .boolean:
      Picker("", selection: row.value) {
        Text(L10n("macCatalog.smartBoolTrue")).tag("true")
        Text(L10n("macCatalog.smartBoolFalse")).tag("false")
      }
      .labelsHidden()
      .frame(width: 110)
    case .number, .date:
      TextField(Self.fieldType(of: row.wrappedValue.field) == .date
        ? L10n("macCatalog.smartDaysPlaceholder")
        : L10n("macCatalog.smartValuePlaceholder"), text: row.value)
        .textFieldStyle(.roundedBorder)
        .frame(width: 78)
      if row.wrappedValue.oper == "inTheRange" {
        Text("–").foregroundStyle(.secondary)
        TextField(L10n("macCatalog.smartValuePlaceholder"), text: row.end)
          .textFieldStyle(.roundedBorder)
          .frame(width: 78)
      }
    case .text:
      TextField(L10n("macCatalog.smartValuePlaceholder"), text: row.value)
        .textFieldStyle(.roundedBorder)
    }
  }
}

private struct MacPlaylistDetail: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  let playlist: Playlist
  var canManage = false
  @Environment(\.dismiss) private var dismiss

  @State private var tracks: [Track] = []
  @State private var message: String?
  @State private var loading = true

  var body: some View {
    VStack(spacing: 0) {
      MacCollectionHeading(
        title: playlist.name,
        subtitle: L10n("macCatalog.trackCount", tracks.count),
        symbol: "music.note.list",
        canPlay: !tracks.isEmpty,
        coverTrackID: playlist.coverTrackId,
        client: client,
        onBack: { dismiss() }
      ) {
        guard let first = tracks.first(where: \.isAvailable) ?? tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
      MacPlayableTracks(
        client: client,
        playback: playback,
        favorites: favorites,
        tracks: tracks,
        emptyTitle: message == nil ? L10n("macCatalog.playlistEmpty") : L10n("macCatalog.cannotLoadPlaylists"),
        emptyDetail: message,
        canManage: canManage,
        playlist: playlist,
        onReload: { await load() },
        isLoading: loading
      )
    }
    .navigationTitle(playlist.name)
    .navigationBarBackButtonHidden(true)
    .toolbar {
      ToolbarItem(placement: .navigation) {
        Button {
          dismiss()
        } label: {
          Image(systemName: "chevron.backward")
        }
        .help(L10n("macCatalog.back"))
        .keyboardShortcut("[", modifiers: .command)
      }
    }
    .task { await load() }
  }

  private func load() async {
    loading = tracks.isEmpty
    do {
      tracks = try await MacPages.playlistTracks(client: client, playlistID: playlist.id)
      message = nil
    } catch {
      tracks = []
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

struct MacFavoritesView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  var canManage = false

  @State private var tracks: [Track] = []
  @State private var message: String?
  @State private var loading = true

  var body: some View {
    VStack(spacing: 0) {
      MacCollectionHeading(
        title: L10n("macCatalog.favoritesTitle"),
        subtitle: loading && tracks.isEmpty
          ? L10n("macCatalog.loadingSubtitle")
          : L10n("macCatalog.favoritesSubtitle", tracks.count, macTotalDurationText(tracks)),
        symbol: "heart.fill",
        canPlay: !tracks.isEmpty,
        tileSymbol: "heart",
        badge: L10n("macCatalog.favoritesBadge"),
        onShuffle: {
          guard let pick = tracks.randomElement() else { return }
          if !playback.isShuffled { playback.toggleShuffle() }
          MacPlayback.play(tracks, startingAt: pick, playback: playback)
        }
      ) {
        guard let first = tracks.first(where: \.isAvailable) ?? tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
      MacPlayableTracks(
        client: client,
        playback: playback,
        favorites: favorites,
        tracks: tracks,
        emptyTitle: message == nil ? L10n("macCatalog.noFavorites") : L10n("macCatalog.cannotLoadFavorites"),
        emptyDetail: message,
        emptyIcon: "heart",
        canManage: canManage,
        onReload: { await load() },
        isLoading: loading
      )
    }
    .navigationTitle(L10n("macCatalog.favoritesTitle"))
    .toolbar {
      QuietToolbarItem {
        MacToolbarIconButton(systemImage: "arrow.clockwise", help: L10n("macCatalog.refresh"), isDisabled: loading) { Task { await load() } }
      }
    }
    .task { await load() }
  }

  private func load() async {
    loading = tracks.isEmpty
    do {
      guard let playlist = try await MacPages.favoritesPlaylist(client: client) else {
        message = L10n("macCatalog.noServerFavoritesPlaylist")
        tracks = []
        loading = false
        return
      }
      tracks = try await MacPages.playlistTracks(client: client, playlistID: playlist.id)
      message = nil
      await favorites?.load()
    } catch {
      tracks = []
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

struct MacListeningView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  var canManage = false

  @State private var tracks: [Track] = []
  @State private var message: String?
  @State private var loading = true

  var body: some View {
    MacPlayableTracks(
      client: client,
      playback: playback,
      favorites: favorites,
      tracks: tracks,
      emptyTitle: message == nil ? L10n("macCatalog.noListeningHistory") : L10n("macCatalog.cannotLoadHistory"),
      emptyDetail: message,
      emptyIcon: "clock",
      canManage: canManage,
      isLoading: loading
    )
    .navigationTitle(L10n("macCatalog.listeningHistoryTitle"))
    .toolbar {
      QuietToolbarItem {
        MacToolbarIconButton(systemImage: "arrow.clockwise", help: L10n("macCatalog.refresh"), isDisabled: loading) { Task { await load() } }
      }
    }
    .task { await load() }
  }

  private func load() async {
    loading = tracks.isEmpty
    do {
      tracks = try await MacPages.collect { offset in
        try await client.tracks(
          limit: 200,
          offset: offset,
          sort: .lastPlayed,
          order: .desc,
          playedOnly: true
        )
      }
      message = nil
    } catch {
      tracks = []
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

struct MacNotificationsView: View {
  let client: WildstringClient

  @State private var page: NotificationPage?
  @State private var message: String?

  var body: some View {
    Group {
      if let page {
        VStack(spacing: 0) {
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(L10n("macCatalog.notificationsTitle"))
              .font(MacTheme.section(18))
              .foregroundStyle(MacTheme.ink)
            Text(
              page.unreadCount > 0
                ? L10n("macCatalog.notificationsUnreadSummary", page.unreadCount, page.items.count)
                : L10n("macCatalog.notificationsAllReadSummary", page.items.count)
            )
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.muted)
            Spacer()
            MacToolbarTextButton(title: L10n("macCatalog.markAllNotificationsRead"), isDisabled: page.unreadCount == 0) {
              Task { await markAll(page.highWatermark) }
            }
          }
          .padding(.horizontal, 24)
          .padding(.top, 20)
          .padding(.bottom, 12)
          Rectangle().fill(MacTheme.border).frame(height: 1)
          ScrollView {
            LazyVStack(spacing: 0) {
              ForEach(page.items) { item in
                notificationRow(item)
              }
            }
          }
        }
      } else if let message {
        ContentUnavailableView(L10n("macCatalog.cannotLoadNotifications"), systemImage: "bell", description: Text(message))
      } else {
        ProgressView()
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(MacTheme.canvas)
    .navigationTitle(L10n("macCatalog.notificationsTitle"))
    .overlay {
      if page?.items.isEmpty == true {
        ContentUnavailableView(L10n("macCatalog.noNotifications"), systemImage: "bell")
      }
    }
    .task { await load() }
  }

  private func notificationRow(_ item: AppNotification) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Circle()
        .fill(item.isUnread ? MacTheme.accent : MacTheme.border.opacity(0.6))
        .frame(width: 7, height: 7)
        .padding(.top, 5)
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Text(localizedNoticeTitle(item.title))
            .font(.system(size: 13, weight: item.isUnread ? .semibold : .regular))
            .foregroundStyle(item.isUnread ? MacTheme.ink : MacTheme.muted)
            .lineLimit(1)
          Spacer(minLength: 12)
          Text(macRelativeTime(item.createdAt) ?? "")
            .font(MacTheme.micro)
            .foregroundStyle(MacTheme.faint)
        }
        if !item.summary.isEmpty {
          Text(localizedNoticeSummary(item.summary))
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.muted)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
    .padding(.horizontal, 24)
    .padding(.vertical, 12)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(MacTheme.border.opacity(0.55))
        .frame(height: 1)
        .padding(.horizontal, 24)
    }
    .task {
      if item.isUnread {
        try? await client.markNotificationsRead(ids: [item.id])
      }
    }
  }

  private func load() async {
    do {
      page = try await client.notifications()
      message = nil
    } catch {
      message = L10n("macCatalog.notificationsUnavailable")
    }
  }

  private func markAll(_ watermark: Int) async {
    try? await client.markAllNotificationsRead(highWatermark: watermark)
    await load()
  }

  private func localizedNoticeTitle(_ title: String) -> String {
    switch title {
    case "整理方式已更新", "整理结果的自动处理方式已更新": return L10n("macCatalog.event.titlePolicyUpdated")
    case "曲库巡检完成", "曲库巡检已完成": return L10n("macCatalog.event.titleInspectionDone")
    case "曲库巡检需要处理", "曲库巡检未完全完成": return L10n("macCatalog.event.titleInspectionPartial")
    case "草案待确认", "曲库整理草案待确认", "导入整理草案待确认": return L10n("macCatalog.event.titleCurationDraftPending")
    case "草案已应用", "曲库整理已自动应用": return L10n("macCatalog.event.titleCurationAutoApplied")
    case "歌词补全与洗版扫描结束", "全库歌词扫描已完成", "专辑歌词扫描已完成": return L10n("macCatalog.event.titleLyricLibraryDone")
    case "导入任务结束", "扫描任务结束", "曲库导入或扫描已完成": return L10n("macCatalog.event.titleImportDone")
    case "元数据查询结束", "元数据批量查询已完成": return L10n("macCatalog.event.titleMetadataBatchDone")
    default: return title
    }
  }

  private func localizedNoticeSummary(_ summary: String) -> String {
    switch summary {
    case "自动应用": return L10n("macCatalog.event.summaryAutoApply")
    case "审核后应用": return L10n("macCatalog.event.summaryManualReview")
    case "任务已完成，请到曲库管理查看逐项结果。": return L10n("macCatalog.event.summaryLibSuccess")
    case "任务已结束，存在需要处理的项目，请到曲库管理查看结果。": return L10n("macCatalog.event.summaryLibWarning")
    default: break
    }
    if let m = try? /^已检查 (\d+) 首，发现 (\d+) 项，失败 (\d+) 首。(?: 错误：(.+))?$/.wholeMatch(in: summary),
       let processed = Int(m.1), let issues = Int(m.2), let failed = Int(m.3) {
      let base = L10n("macCatalog.event.summaryInspCounts", processed, issues, failed)
      if let err = m.4 { return base + L10n("macCatalog.event.summaryInspErrSuffix", String(err)) }
      return base
    }
    if let m = try? /^可升级 (\d+) 首，待核对 (\d+) 首，未匹配 (\d+) 首，失败 (\d+) 首。请到歌词补全查看并确认。$/.wholeMatch(in: summary),
       let ready = Int(m.1), let review = Int(m.2), let noMatch = Int(m.3), let failed = Int(m.4) {
      return L10n("macCatalog.event.summaryLyricCounts", ready, review, noMatch, failed)
    }
    if let m = try? /^查询结束：建议已生成 (\d+) 首，未匹配 (\d+) 首，失败 (\d+) 首，已变化 (\d+) 首。建议需要确认后应用。(?:其中 (\d+) 首有来源警告。)?$/.wholeMatch(in: summary),
       let completed = Int(m.1), let noMatch = Int(m.2), let failed = Int(m.3), let stale = Int(m.4) {
      let base = L10n("macCatalog.event.summaryMetaCounts", completed, noMatch, failed, stale)
      if let warnStr = m.5, let warn = Int(warnStr) { return base + L10n("macCatalog.event.summaryMetaWarnSuffix", warn) }
      return base
    }
    return summary
  }
}
