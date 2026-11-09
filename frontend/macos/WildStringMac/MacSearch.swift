import CoreNetwork
import CorePlayback
import Observation
import SwiftUI

@MainActor
@Observable
final class MacSearchModel {
  private let client: WildstringClient
  private var searchTask: Task<Void, Never>?

  private(set) var query = ""
  private(set) var tracks: [Track] = []
  private(set) var albums: [Album] = []
  private(set) var artists: [Artist] = []
  private(set) var loading = false
  private(set) var error: String?

  init(client: WildstringClient) {
    self.client = client
  }

  var hasQuery: Bool {
    !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var resultCount: Int {
    tracks.count + albums.count + artists.count
  }

  func update(query: String) {
    self.query = query
    searchTask?.cancel()
    let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      tracks = []
      albums = []
      artists = []
      loading = false
      error = nil
      return
    }
    loading = true
    searchTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(280))
      guard !Task.isCancelled else { return }
      await self?.search(text)
    }
  }

  private func search(_ text: String) async {
    do {
      async let trackPage = client.tracks(limit: 80, query: text)
      async let albumPage = client.albums(limit: 24, query: text)
      async let artistPage = client.artists(limit: 24, query: text)
      let results = try await (trackPage, albumPage, artistPage)
      guard !Task.isCancelled, query.trimmingCharacters(in: .whitespacesAndNewlines) == text else {
        return
      }
      tracks = results.0.items
      albums = results.1.items
      artists = results.2.items
      error = nil
    } catch is CancellationError {
      return
    } catch {
      guard !Task.isCancelled,
        query.trimmingCharacters(in: .whitespacesAndNewlines) == text
      else { return }
      tracks = []
      albums = []
      artists = []
      self.error = MacErrorText.message(for: error)
    }
    guard query.trimmingCharacters(in: .whitespacesAndNewlines) == text else { return }
    loading = false
  }
}

struct MacSearchView: View {
  let client: WildstringClient
  let playback: PlaybackService
  let favorites: MacFavorites?
  @Binding var focusSearch: Bool

  @State private var model: MacSearchModel
  @State private var query = ""
  @State private var category = "all"
  @State private var playlistSelection: MacPlaylistSelection?
  @State private var lyricTrack: Track?
  @State private var notice: String?
  @FocusState private var searchFocused: Bool
  @Environment(\.navigateToTrackCollection) private var navigate

  init(
    client: WildstringClient,
    playback: PlaybackService,
    favorites: MacFavorites?,
    focusSearch: Binding<Bool>
  ) {
    self.client = client
    self.playback = playback
    self.favorites = favorites
    _focusSearch = focusSearch
    _model = State(initialValue: MacSearchModel(client: client))
  }

  var body: some View {
    VStack(spacing: 0) {
      searchHeader
      Rectangle().fill(MacTheme.border).frame(height: 1)
      results
    }
    .background(MacTheme.canvas)
    .navigationTitle(L10n("macSearch.title"))
    .overlay(alignment: .bottom) {
      if let notice {
        Text(notice)
          .font(.callout)
          .foregroundStyle(MacTheme.ink)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .background(MacTheme.panel, in: Capsule())
          .overlay(Capsule().strokeBorder(MacTheme.border, lineWidth: 1))
          .padding(.bottom, 14)
      }
    }
    .sheet(item: $playlistSelection) { selection in
      MacAddToPlaylistSheet(client: client, tracks: selection.tracks) { message in
        showNotice(message)
      }
    }
    .sheet(item: $lyricTrack) { track in
      MacLyricsPreview(client: client, track: track)
    }
    .onChange(of: query) { _, value in model.update(query: value) }
    .onChange(of: focusSearch) { _, requested in
      guard requested else { return }
      searchFocused = true
      focusSearch = false
    }
    .onAppear {
      guard focusSearch else { return }
      searchFocused = true
      focusSearch = false
    }
  }

  private var searchHeader: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .firstTextBaseline) {
        Text(L10n("macSearch.title"))
          .font(MacTheme.display(26))
          .foregroundStyle(MacTheme.ink)
        if model.hasQuery && !model.loading {
          Text(L10n("macSearch.matchCount", model.resultCount))
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.muted)
        }
        Spacer()
        if !model.tracks.isEmpty, let first = model.tracks.first(where: \.isAvailable) ?? model.tracks.first {
          Button {
            MacPlayback.play(model.tracks, startingAt: first, playback: playback)
          } label: {
            Label(L10n("macSearch.playTracks"), systemImage: "play.fill")
              .font(MacTheme.section(12))
          }
          .buttonStyle(.borderedProminent)
          .tint(MacTheme.accentDeep)
          .controlSize(.regular)
        }
      }

      HStack(spacing: 10) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(searchFocused ? MacTheme.accentDeep : MacTheme.muted)
        TextField(L10n("macSearch.searchPlaceholder"), text: $query)
          .textFieldStyle(.plain)
          .font(.system(size: 14))
          .foregroundStyle(MacTheme.ink)
          .focused($searchFocused)
        if model.loading {
          ProgressView()
            .controlSize(.small)
        } else if !query.isEmpty {
          Button {
            query = ""
            searchFocused = true
          } label: {
            Image(systemName: "xmark.circle.fill")
              .foregroundStyle(MacTheme.muted)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(L10n("macSearch.clearSearch"))
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(
        MacTheme.raised,
        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(searchFocused ? MacTheme.accent : MacTheme.border, lineWidth: 1)
      )

      if model.hasQuery && model.resultCount > 0 {
        HStack(spacing: 8) {
          categoryChip(L10n("macSearch.categoryAll"), id: "all", count: model.resultCount)
          if !model.tracks.isEmpty {
            categoryChip(L10n("macSearch.categoryTracks"), id: "tracks", count: model.tracks.count)
          }
          if !model.albums.isEmpty {
            categoryChip(L10n("macSearch.categoryAlbums"), id: "albums", count: model.albums.count)
          }
          if !model.artists.isEmpty {
            categoryChip(L10n("macSearch.categoryArtists"), id: "artists", count: model.artists.count)
          }
        }
      }
    }
    .padding(.horizontal, 24)
    .padding(.vertical, 18)
    .background(MacTheme.canvas)
  }

  private func categoryChip(_ label: String, id: String, count: Int) -> some View {
    let active = category == id
    return Button {
      category = id
    } label: {
      HStack(spacing: 5) {
        Text(label)
          .font(.system(size: 12, weight: active ? .semibold : .regular))
        Text("\(count)")
          .font(MacTheme.mono(10))
      }
      .foregroundStyle(active ? MacTheme.accentDeep : MacTheme.muted)
      .padding(.horizontal, 11)
      .padding(.vertical, 5)
      .background(
        active ? MacTheme.accentSoft : MacTheme.panel,
        in: Capsule()
      )
      .overlay(
        Capsule()
          .strokeBorder(active ? MacTheme.accent.opacity(0.45) : MacTheme.border, lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private var results: some View {
    if !model.hasQuery {
      ContentUnavailableView(
        L10n("macSearch.emptyTitle"),
        systemImage: "magnifyingglass",
        description: Text(L10n("macSearch.emptyDesc"))
      )
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(MacTheme.canvas)
    } else if model.loading, model.resultCount == 0 {
      ProgressView(L10n("macSearch.searching"))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MacTheme.canvas)
    } else if let error = model.error, model.resultCount == 0 {
      ContentUnavailableView(
        L10n("macSearch.searchFailed"),
        systemImage: "wifi.exclamationmark",
        description: Text(error)
      )
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(MacTheme.canvas)
    } else if model.resultCount == 0 {
      ContentUnavailableView.search(text: model.query)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MacTheme.canvas)
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 26) {
          if let error = model.error {
            Label(error, systemImage: "exclamationmark.triangle")
              .font(.callout)
              .foregroundStyle(MacTheme.accentDeep)
          }
          if !model.tracks.isEmpty && (category == "all" || category == "tracks") {
            resultSection(L10n("macSearch.categoryTracks"), count: model.tracks.count, symbol: "music.note") {
              VStack(spacing: 6) {
                ForEach(model.tracks) { track in
                  searchTrackRow(track)
                }
              }
            }
          }
          if !model.albums.isEmpty && (category == "all" || category == "albums") {
            resultSection(L10n("macSearch.categoryAlbums"), count: model.albums.count, symbol: "square.stack") {
              LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 168, maximum: 196), spacing: 16)],
                spacing: 16
              ) {
                ForEach(model.albums) { album in
                  MacCatalogCard(
                    client: client,
                    value: MacTrackDestination.album(id: album.id, title: album.title),
                    title: album.title,
                    subtitle: album.artists.joined(separator: " / "),
                    cover: album.coverTrackId
                  )
                }
              }
            }
          }
          if !model.artists.isEmpty && (category == "all" || category == "artists") {
            resultSection(L10n("macSearch.categoryArtists"), count: model.artists.count, symbol: "person.2") {
              LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 220, maximum: 300), spacing: 14)],
                spacing: 14
              ) {
                ForEach(model.artists) { artist in
                  NavigationLink(
                    value: MacTrackDestination.artist(name: artist.name)
                  ) {
                    HStack(spacing: 12) {
                      MacCover(
                        client: client,
                        trackID: artist.coverTrackId.isEmpty
                          ? nil : artist.coverTrackId,
                        side: 48,
                        cornerRadius: 24,
                        placeholder: "person.fill"
                      )
                      VStack(alignment: .leading, spacing: 3) {
                        Text(artist.name)
                          .font(.system(size: 13, weight: .semibold))
                          .foregroundStyle(MacTheme.ink)
                          .lineLimit(1)
                        Text(L10n("macSearch.artistCounts", artist.albumCount, artist.trackCount))
                          .font(MacTheme.caption)
                          .foregroundStyle(MacTheme.muted)
                      }
                      Spacer()
                      Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(MacTheme.faint)
                    }
                    .padding(12)
                    .background(
                      MacTheme.panel,
                      in: RoundedRectangle(cornerRadius: MacTheme.cardRadius, style: .continuous)
                    )
                    .overlay(
                      RoundedRectangle(cornerRadius: MacTheme.cardRadius, style: .continuous)
                        .strokeBorder(MacTheme.border, lineWidth: 1)
                    )
                  }
                  .buttonStyle(.plain)
                }
              }
            }
          }
        }
        .padding(24)
        .frame(maxWidth: 1180, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .top)
      }
      .background(MacTheme.canvas)
    }
  }

  private func searchTrackRow(_ track: Track) -> some View {
    let current = playback.currentItem?.trackID == track.id
    return HStack(spacing: 14) {
      Button {
        MacPlayback.play(model.tracks, startingAt: track, playback: playback)
      } label: {
        MacCover(
          client: client,
          trackID: track.hasCover ? track.id : (track.album != nil ? track.id : nil),
          side: 42
        )
      }
      .buttonStyle(.plain)
      .help(L10n("macSearch.playTrack", track.title))

      VStack(alignment: .leading, spacing: 3) {
        Button {
          MacPlayback.play(model.tracks, startingAt: track, playback: playback)
        } label: {
          Text(track.title)
            .font(.system(size: 13, weight: current ? .semibold : .regular))
            .foregroundStyle(!track.isAvailable ? MacTheme.muted : current ? MacTheme.accentDeep : MacTheme.ink)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        if let reason = track.unavailableReason {
          Label(reason, systemImage: "exclamationmark.circle").font(MacTheme.caption).foregroundStyle(MacTheme.muted)
        }
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
      .frame(maxWidth: .infinity, alignment: .leading)

      HStack(spacing: 6) {
        if let favorites {
          Button {
            Task { await favorites.toggle(track.id) }
          } label: {
            Image(systemName: favorites.isFavorite(track.id) ? "heart.fill" : "heart")
              .foregroundStyle(favorites.isFavorite(track.id) ? MacTheme.accentDeep : MacTheme.faint)
          }
          .buttonStyle(.plain)
          .help(favorites.isFavorite(track.id) ? L10n("macSearch.unfavorite") : L10n("macSearch.favorite"))
        }
        if current {
          Image(systemName: playback.isPlaying ? "speaker.wave.2.fill" : "pause.fill")
            .foregroundStyle(MacTheme.accentDeep)
        }
      }
      .font(.caption)

      Text(macClock(milliseconds: track.durationMs))
        .font(MacTheme.mono())
        .foregroundStyle(MacTheme.faint)
        .frame(width: 48, alignment: .trailing)

      Menu {
        trackMenu(track)
      } label: {
        Image(systemName: "ellipsis")
          .frame(width: 26, height: 28)
          .contentShape(Rectangle())
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
      .accessibilityLabel(L10n("macSearch.moreActionsFor", track.title))
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(
      current ? MacTheme.accentSoft : MacTheme.panel,
      in: RoundedRectangle(cornerRadius: MacTheme.rowRadius, style: .continuous)
    )
    .overlay(
      RoundedRectangle(cornerRadius: MacTheme.rowRadius, style: .continuous)
        .strokeBorder(current ? MacTheme.accent.opacity(0.45) : MacTheme.border, lineWidth: 1)
    )
    .overlay(alignment: .leading) {
      if current {
        Capsule()
          .fill(MacTheme.accent)
          .frame(width: 3)
          .padding(.vertical, 8)
      }
    }
    .contextMenu {
      trackMenu(track)
    }
  }

  @ViewBuilder
  private func artistLink(_ track: Track) -> some View {
    if track.artists.count == 1, let name = track.artists.first {
      Button {
        navigate(.artist(name: name))
      } label: {
        Text(name).lineLimit(1)
      }
      .buttonStyle(.plain)
      .foregroundStyle(MacTheme.muted)
      .help(L10n("macSearch.viewArtist", name))
    } else if track.artists.count > 1 {
      Menu {
        ForEach(track.artists, id: \.self) { name in
          Button(name) { navigate(.artist(name: name)) }
        }
      } label: {
        Text(track.artists.joined(separator: " / ")).lineLimit(1)
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .foregroundStyle(MacTheme.muted)
    } else {
      Text("—").foregroundStyle(MacTheme.faint)
    }
  }

  @ViewBuilder
  private func albumLink(_ track: Track) -> some View {
    if let id = track.albumId, let title = track.album, !title.isEmpty {
      Button {
        navigate(.album(id: id, title: title))
      } label: {
        Text(title).lineLimit(1)
      }
      .buttonStyle(.plain)
      .foregroundStyle(MacTheme.muted)
      .help(L10n("macSearch.viewAlbum", title))
    } else if let title = track.album, !title.isEmpty {
      Text(title).lineLimit(1).foregroundStyle(MacTheme.muted)
    }
  }

  @ViewBuilder
  private func trackMenu(_ track: Track) -> some View {
    Button(L10n("macSearch.playNext")) { enqueue([track], next: true) }
    Button(L10n("macSearch.addToQueue")) { enqueue([track]) }
    Button(L10n("macSearch.addToPlaylist")) { playlistSelection = MacPlaylistSelection(tracks: [track]) }
    Button(L10n("macSearch.viewLyrics")) { lyricTrack = track }
    if let id = track.albumId, let title = track.album, !title.isEmpty {
      Button(L10n("macSearch.viewAlbumMenu")) { navigate(.album(id: id, title: title)) }
    }
    ForEach(track.artists, id: \.self) { name in
      Button(L10n("macSearch.viewArtist", name)) { navigate(.artist(name: name)) }
    }
    if let favorites {
      Divider()
      Button(favorites.isFavorite(track.id) ? L10n("macSearch.unfavorite") : L10n("macSearch.favorite")) {
        Task { await favorites.toggle(track.id) }
      }
    }
  }

  private func enqueue(_ tracks: [Track], next: Bool = false) {
    if playback.enqueue(items: tracks.map(MacPlayback.item), next: next) {
      showNotice(next ? L10n("macSearch.enqueuedNext", tracks.count) : L10n("macSearch.enqueuedEnd", tracks.count))
    } else if let error = playback.errorMessage {
      showNotice(error)
    }
  }

  private func showNotice(_ text: String) {
    notice = text
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(3))
      if notice == text { notice = nil }
    }
  }

  private func resultSection<Content: View>(
    _ title: String,
    count: Int,
    symbol: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Image(systemName: symbol)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(MacTheme.accentDeep)
        Text(title)
          .font(MacTheme.section(16))
          .foregroundStyle(MacTheme.ink)
        Text("\(count)")
          .font(MacTheme.mono(11))
          .foregroundStyle(MacTheme.muted)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(MacTheme.panel, in: Capsule())
      }
      content()
    }
  }
}
