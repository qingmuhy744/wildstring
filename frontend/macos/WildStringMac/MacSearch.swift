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
  @FocusState private var searchFocused: Bool

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
      searchField
      Divider()
      results
    }
    .navigationTitle("搜索")
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

  private var searchField: some View {
    HStack(spacing: 10) {
      Image(systemName: "magnifyingglass")
        .foregroundStyle(.secondary)
      TextField("歌曲、专辑或艺人", text: $query)
        .textFieldStyle(.plain)
        .font(.title3)
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
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("清除搜索")
      }
    }
    .padding(.horizontal, 22)
    .padding(.vertical, 16)
    .background(.bar)
  }

  @ViewBuilder
  private var results: some View {
    if !model.hasQuery {
      ContentUnavailableView(
        "搜索整个曲库",
        systemImage: "magnifyingglass",
        description: Text("输入歌曲、专辑或艺人，三类结果会同时显示。")
      )
    } else if model.loading, model.resultCount == 0 {
      ProgressView("正在搜索…")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if let error = model.error, model.resultCount == 0 {
      ContentUnavailableView(
        "无法完成搜索",
        systemImage: "wifi.exclamationmark",
        description: Text(error)
      )
    } else if model.resultCount == 0 {
      ContentUnavailableView.search(text: model.query)
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 26) {
          if let error = model.error {
            Label(error, systemImage: "exclamationmark.triangle")
              .font(.callout)
              .foregroundStyle(.orange)
          }
          if !model.tracks.isEmpty {
            resultSection("歌曲", count: model.tracks.count, symbol: "music.note") {
              ForEach(model.tracks) { track in
                Button {
                  MacPlayback.play(model.tracks, startingAt: track, playback: playback)
                } label: {
                  HStack(spacing: 12) {
                    MacCover(
                      client: client,
                      trackID: track.hasCover ? track.id : nil,
                      side: 42
                    )
                    VStack(alignment: .leading, spacing: 4) {
                      Text(track.title)
                        .fontWeight(
                          playback.currentItem?.trackID == track.id
                            ? .semibold : .regular
                        )
                        .lineLimit(1)
                      Text(trackSubtitle(track))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    }
                    Spacer(minLength: 16)
                    if let favorites, favorites.isFavorite(track.id) {
                      Image(systemName: "heart.fill")
                        .foregroundStyle(MacTheme.accentDeep)
                    }
                    Text(macClock(milliseconds: track.durationMs))
                      .font(.caption.monospacedDigit())
                      .foregroundStyle(.secondary)
                  }
                  .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("播放 \(track.title)")
              }
            }
          }
          if !model.albums.isEmpty {
            resultSection("专辑", count: model.albums.count, symbol: "square.stack") {
              LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 150, maximum: 190), spacing: 18)],
                spacing: 18
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
          if !model.artists.isEmpty {
            resultSection("艺人", count: model.artists.count, symbol: "person.2") {
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
                        side: 52,
                        cornerRadius: 26,
                        placeholder: "person.fill"
                      )
                      VStack(alignment: .leading, spacing: 4) {
                        Text(artist.name)
                          .font(.callout.weight(.semibold))
                          .lineLimit(1)
                        Text("\(artist.albumCount) 张专辑 · \(artist.trackCount) 首")
                          .font(.caption)
                          .foregroundStyle(.secondary)
                      }
                      Spacer()
                      Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                    }
                    .padding(10)
                    .background(
                      .quaternary.opacity(0.35),
                      in: RoundedRectangle(cornerRadius: 10)
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
    }
  }

  private func resultSection<Content: View>(
    _ title: String,
    count: Int,
    symbol: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label {
        HStack(spacing: 8) {
          Text(title)
          Text("\(count)")
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
      } icon: {
        Image(systemName: symbol)
          .foregroundStyle(MacTheme.accentDeep)
      }
      .font(.title3.bold())
      content()
    }
  }

  private func trackSubtitle(_ track: Track) -> String {
    var parts = track.artists
    if let album = track.album, !album.isEmpty {
      parts.append(album)
    }
    return parts.joined(separator: " · ")
  }
}
