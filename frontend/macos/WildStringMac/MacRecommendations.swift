import CoreNetwork
import CorePlayback
import SwiftUI

struct MacDiscoverView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?

  @State private var daily: DailyRecommendations?
  @State private var rejected: Set<String> = []
  @State private var rankings: [RankingRow] = []
  @State private var section = "daily"
  @State private var scope = "personal"
  @State private var period = "30d"
  @State private var loading = true
  @State private var refreshing = false
  @State private var message: String?
  @State private var saving = false
  @State private var selecting = false

  private var visibleDailyItems: [RecommendationItem] {
    daily?.items.filter { !rejected.contains($0.track.id) } ?? []
  }

  private var tracks: [Track] {
    section == "daily"
      ? visibleDailyItems.map(\.track)
      : rankings.map(\.track)
  }

  private var dailyReasonByTrackID: [String: String] {
    Dictionary(uniqueKeysWithValues: visibleDailyItems.map { ($0.track.id, $0.reason) })
  }

  private var rankingByTrackID: [String: RankingRow] {
    Dictionary(uniqueKeysWithValues: rankings.map { ($0.track.id, $0) })
  }

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 14) {
        HStack(spacing: 12) {
          Picker(L10n("macRec.discoveryCategory"), selection: $section) {
            Text(L10n("macRec.dailyRecommendations")).tag("daily")
            Text(L10n("macRec.listeningRankings")).tag("rankings")
          }
          .pickerStyle(.segmented)
          .labelsHidden()
          .frame(width: 220)

          Spacer()

          if section == "rankings" {
            Picker(L10n("macRec.scope"), selection: $scope) {
              Text(L10n("macRec.scopeMine")).tag("personal")
              Text(L10n("macRec.scopeCommunity")).tag("community")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 140)

            Picker(L10n("macRec.period"), selection: $period) {
              Text(L10n("macRec.period7d")).tag("7d")
              Text(L10n("macRec.period30d")).tag("30d")
              Text(L10n("macRec.periodAll")).tag("all")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 180)
          }
        }

        HStack(alignment: .center, spacing: 18) {
          MacDailyMosaic(client: client, tracks: tracks, side: 84)

          VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
              Text(section == "daily" ? formattedDailyDate(daily?.date) : rankingKicker)
                .font(MacTheme.micro)
                .foregroundStyle(MacTheme.accentDeep)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(MacTheme.accentSoft, in: Capsule())

              if section == "daily", daily?.engine == "ai" {
                Text(L10n("macRec.aiCurated"))
                  .font(MacTheme.micro)
                  .foregroundStyle(MacTheme.olive)
                  .padding(.horizontal, 8)
                  .padding(.vertical, 3)
                  .background(MacTheme.oliveSoft, in: Capsule())
              }
            }

            Text(section == "daily" ? L10n("macRec.dailyHeader") : L10n("macRec.rankingsHeader"))
              .font(MacTheme.display(24))
              .foregroundStyle(MacTheme.ink)

            Text(section == "daily" ? dailySubtitle : rankingSubtitle)
              .font(MacTheme.caption)
              .foregroundStyle(MacTheme.muted)
              .lineLimit(2)
          }

          Spacer(minLength: 16)

          VStack(alignment: .trailing, spacing: 8) {
            Button {
              if let first = tracks.first(where: \.isAvailable) ?? tracks.first {
                MacPlayback.play(tracks, startingAt: first, playback: playback)
              }
            } label: {
              Label(L10n("macRec.playAll"), systemImage: "play.fill")
                .font(MacTheme.section(13))
            }
            .disabled(tracks.isEmpty)
            .buttonStyle(.borderedProminent)
            .tint(MacTheme.accentDeep)
            .controlSize(.large)

            HStack(spacing: 8) {
              if section == "daily" {
                Button(refreshing ? L10n("macRec.generating") : L10n("macRec.generateNew")) {
                  Task { await refresh() }
                }
                .disabled(refreshing)
              }
              Button(L10n("macRec.savePlaylist")) { saving = true }
                .disabled(tracks.isEmpty)
              Button(selecting ? L10n("macRec.finishSelecting") : L10n("macRec.selectTracks")) {
                selecting.toggle()
              }
              .disabled(tracks.isEmpty && !selecting)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
          }
        }
        .macPanel(padding: 16, radius: MacTheme.panelRadius)

        if let message {
          Text(message).font(.callout).foregroundStyle(MacTheme.accentDeep).textSelection(.enabled)
        }
        if section == "daily", daily?.degraded == true {
          Text(L10n("macRec.degradedNotice"))
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.muted)
        }
      }
      .padding(.horizontal, 24)
      .padding(.vertical, 16)
      .background(MacTheme.canvas)

      Rectangle().fill(MacTheme.border).frame(height: 1)

      MacPlayableTracks(
        client: client,
        playback: playback,
        favorites: favorites,
        tracks: tracks,
        emptyTitle: message == nil ? L10n("macRec.emptyRecommendations") : L10n("macRec.cannotLoadRecommendations"),
        emptyDetail: message,
        isLoading: loading,
        allowsSelection: true,
        externalSelecting: $selecting,
        trackBadge: section == "rankings"
          ? { track in
            guard let row = rankingByTrackID[track.id] else { return nil }
            return String(format: "%02d", row.rank)
          }
          : nil,
        trackReason: { track in
          if section == "daily" {
            return dailyReasonByTrackID[track.id]
          }
          guard let row = rankingByTrackID[track.id] else { return nil }
          let minutes = max(1, Int(row.listenedMs / 60_000))
          if row.reason.isEmpty {
            return L10n("macRec.rankPlayCountMinutes", row.playCount, minutes)
          }
          return L10n("macRec.rankPlayCountReason", row.playCount, row.reason)
        },
        onRecommendationFeedback: section == "daily"
          ? { track, action in await feedback(track, action: action) } : nil
      )
      .id(section == "daily" ? daily?.id ?? "daily" : "rankings-\(scope)-\(period)")
    }
    .background(MacTheme.canvas)
    .navigationTitle(L10n("macRec.dailyRecommendations"))
    .toolbar {
      Button(refreshing ? L10n("macRec.generating") : L10n("macRec.generateNew")) { Task { await refresh() } }
        .disabled(refreshing || section != "daily")
      Button(L10n("macRec.refresh"), systemImage: "arrow.clockwise") { Task { await load() } }.disabled(loading)
    }
    .sheet(isPresented: $saving) {
      MacAddToPlaylistSheet(client: client, tracks: tracks) { message = $0 }
    }
    .onChange(of: section) { _, _ in selecting = false }
    .task { await load() }
    .task(id: "\(scope)-\(period)") { await loadRankings() }
  }

  private var dailySubtitle: String {
    let countText = L10n("macRec.trackCount", tracks.count)
    guard let sources = daily?.sources else {
      return countText
    }
    let known = (sources["favorite"] ?? 0) + (sources["history"] ?? 0) + (sources["frequent"] ?? 0)
    let explore = (sources["explore"] ?? 0) + (sources["unheard"] ?? 0) + (sources["fresh"] ?? 0)
    if known > 0 && explore > 0 {
      return L10n("macRec.dailySubtitleBoth", countText, known, explore)
    }
    if known > 0 {
      return L10n("macRec.dailySubtitleKnown", countText, known)
    }
    if explore > 0 {
      return L10n("macRec.dailySubtitleExplore", countText, explore)
    }
    return countText
  }

  private var rankingKicker: String {
    scope == "personal" ? L10n("macRec.scopeMineKicker") : L10n("macRec.scopeCommunityKicker")
  }

  private var rankingSubtitle: String {
    let periodLabel = period == "7d" ? L10n("macRec.periodLabel7d") : (period == "30d" ? L10n("macRec.periodLabel30d") : L10n("macRec.periodLabelAll"))
    return L10n("macRec.rankingSubtitle", tracks.count, periodLabel)
  }

  private func formattedDailyDate(_ raw: String?) -> String {
    guard let raw, !raw.isEmpty else { return L10n("macRec.todayRecommendation") }
    let parts = raw.split(separator: "-")
    if parts.count == 3, let month = Int(parts[1]), let day = Int(parts[2]) {
      return L10n("macRec.formattedDailyDate", month, day)
    }
    return raw
  }

  private func load() async {
    loading = true
    defer { loading = false }
    do {
      daily = try await client.dailyRecommendations()
      rejected = []
      message = nil
    } catch { message = MacErrorText.message(for: error) }
  }
  private func refresh() async {
    refreshing = true
    defer { refreshing = false }
    do {
      daily = try await client.refreshDailyRecommendations()
      rejected = []
      message = nil
    } catch { message = MacErrorText.message(for: error) }
  }
  private func loadRankings() async {
    do {
      rankings = try await client.rankings(scope: scope, period: period, metric: "plays").items
    } catch { message = MacErrorText.message(for: error) }
  }
  private func feedback(_ track: Track, action: String) async {
    do {
      try await client.recommendationFeedback(trackID: track.id, action: action)
      rejected.insert(track.id)
      message = L10n("macRec.preferenceSaved")
    } catch { message = MacErrorText.message(for: error) }
  }
}

private struct MacDailyMosaic: View {
  let client: WildstringClient
  let tracks: [Track]
  var side: CGFloat = 84

  private var coverTracks: [Track] {
    Array(tracks.filter(\.hasCover).prefix(4))
  }

  var body: some View {
    if coverTracks.count >= 4 {
      let cell = (side - 4) / 2
      VStack(spacing: 4) {
        HStack(spacing: 4) {
          MacCover(client: client, trackID: coverTracks[0].id, side: cell, cornerRadius: 6)
          MacCover(client: client, trackID: coverTracks[1].id, side: cell, cornerRadius: 6)
        }
        HStack(spacing: 4) {
          MacCover(client: client, trackID: coverTracks[2].id, side: cell, cornerRadius: 6)
          MacCover(client: client, trackID: coverTracks[3].id, side: cell, cornerRadius: 6)
        }
      }
      .frame(width: side, height: side)
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    } else if let first = coverTracks.first ?? tracks.first {
      MacCover(
        client: client,
        trackID: first.hasCover ? first.id : nil,
        side: side,
        cornerRadius: 12,
        placeholder: "sparkles"
      )
    } else {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(MacTheme.accentSoft)
        .frame(width: side, height: side)
        .overlay {
          Image(systemName: "sparkles")
            .font(.system(size: side * 0.34, weight: .medium))
            .foregroundStyle(MacTheme.accentDeep)
        }
    }
  }
}

struct MacPlaylistSelection: Identifiable {
  let id = UUID()
  let tracks: [Track]
}

struct MacAddToPlaylistSheet: View {
  let client: WildstringClient
  let tracks: [Track]
  var onSaved: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var playlists: [Playlist] = []
  @State private var target = "new"
  @State private var name = ""
  @State private var created: Playlist?
  @State private var busy = false
  @State private var loading = true
  @State private var message: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text(L10n("macRec.addToPlaylist")).font(.title2.bold())
      Text(L10n("macRec.selectedTracksOrder", tracks.count)).foregroundStyle(.secondary)
      Picker(L10n("macRec.targetPlaylist"), selection: $target) {
        Text(L10n("macRec.newPlaylist")).tag("new")
        ForEach(playlists) { Text($0.name).tag($0.id) }
      }.disabled(busy || created != nil || loading)
      if target == "new" { TextField(L10n("macRec.playlistName"), text: $name).disabled(busy || created != nil) }
      if loading { ProgressView() }
      if let message { Text(message).font(.callout).foregroundStyle(.orange) }
      HStack {
        Spacer()
        Button(L10n("macRec.cancel")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
        Button(busy ? L10n("macRec.adding") : L10n("macRec.confirmAdd")) { Task { await save() } }
          .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
          .disabled(
            tracks.isEmpty || busy || loading
              || (target == "new" && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
      }
    }.padding(24).frame(width: 420)
      .interactiveDismissDisabled(busy)
      .task {
        do { playlists = try await MacPages.playlists(client: client).filter(\.isEditable) } catch {
          message = MacErrorText.message(for: error)
        }
        loading = false
      }
  }

  private func save() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let playlist: Playlist
      if let created {
        playlist = try await client.playlist(id: created.id)
      } else if target == "new" {
        playlist = try await client.createPlaylist(
          name: name.trimmingCharacters(in: .whitespacesAndNewlines))
        created = playlist
      } else {
        playlist = try await client.playlist(id: target)
      }
      try await client.addTracks(
        playlistID: playlist.id, trackIDs: tracks.map(\.id), version: playlist.version)
      onSaved(L10n("macRec.addedToPlaylist", playlist.name))
      dismiss()
    } catch {
      message = (created == nil ? "" : L10n("macRec.playlistCreatedPendingTracks")) + MacErrorText.message(for: error)
    }
  }
}

struct MacLyricsPreview: View {
  let client: WildstringClient
  let track: Track
  @Environment(\.dismiss) private var dismiss
  @State private var lyrics: Lyrics?
  @State private var message: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text(track.title).font(.title2.bold())
        Spacer()
        Button(L10n("macRec.close")) { dismiss() }.keyboardShortcut(.cancelAction)
      }
      Text(L10n("macRec.lyricsPreviewTitle", track.artists.joined(separator: " / "))).foregroundStyle(.secondary)
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if let message {
            Text(message).foregroundStyle(.orange)
          } else if let lyrics {
            if lyrics.lines.isEmpty { Text(L10n("macRec.noLyrics")) }
            ForEach(Array(lyrics.lines.enumerated()), id: \.offset) { _, line in
              Text(line.text).textSelection(.enabled)
            }
          } else {
            ProgressView(L10n("macRec.loadingLyrics"))
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
    }.padding(24).frame(width: 480, height: 520)
      .task {
        do { lyrics = try await client.lyrics(trackID: track.id) } catch {
          message = MacErrorText.message(for: error)
        }
      }
  }
}
