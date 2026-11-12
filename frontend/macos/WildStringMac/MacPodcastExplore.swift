import CoreNetwork
import SwiftUI

struct MacPodcastExplore: View {
    let client: WildstringClient
    let onFollowed: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var region = ""
    @State private var page: PodcastDirectoryPage?
    @State private var selected: PodcastDirectoryResult?
    @State private var preview: PodcastFeedPreview?
    @State private var loading = true
    @State private var previewing = false
    @State private var adding = false
    @State private var canAdd = false
    @State private var error: String?
    @State private var previewError: String?
    @State private var retry = 0
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Button { dismiss() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain).accessibilityLabel(L10n("macPodcastExplore.dismissExplore"))
                Text(L10n("macPodcastExplore.title")).font(.title2.bold())
                Spacer()
                Picker(L10n("macPodcastExplore.regionPicker"), selection: $region) {
                    Text(L10n("macPodcastExplore.serverDefault")).tag("")
                    Text(L10n("macPodcastExplore.regionTaiwan")).tag("tw"); Text(L10n("macPodcastExplore.regionChina")).tag("cn")
                    Text(L10n("macPodcastExplore.regionHongKong")).tag("hk"); Text(L10n("macPodcastExplore.regionUnitedStates")).tag("us")
                    Text(L10n("macPodcastExplore.regionJapan")).tag("jp"); Text(L10n("macPodcastExplore.regionUnitedKingdom")).tag("gb")
                }.frame(width: 185).disabled(!query.isEmpty)
            }
            MacSearchField(placeholder: L10n("macPodcastExplore.searchPrompt"), text: $query, focused: $searchFocused, maxWidth: .infinity)
            HStack {
                Text(query.isEmpty ? L10n("macPodcastExplore.regionalTopCharts", page?.regions.joined(separator: ", ").uppercased() ?? "") : L10n("macPodcastExplore.catalogSearch"))
                Spacer()
                if loading { ProgressView().controlSize(.small) }
            }.font(.caption).foregroundStyle(MacTheme.muted)
            if let error {
                HStack { Text(error).foregroundStyle(MacTheme.muted); Button(L10n("macPodcastExplore.retry")) { retry += 1 } }
            }
            if let page, !page.failedRegions.isEmpty {
                Text(L10n("macPodcastExplore.failedRegions", page.failedRegions.map(\.region).joined(separator: ", "))).font(.caption).foregroundStyle(MacTheme.warning)
            }
            HSplitView {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(page?.results ?? []) { result in
                            Button { selected = result } label: {
                                HStack(spacing: 12) {
                                    MacPodcastArtwork(url: URL(string: result.artworkURL), side: 54)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(result.title).font(.headline).lineLimit(2)
                                        Text(result.author).font(.caption).foregroundStyle(MacTheme.muted).lineLimit(1)
                                        Text(result.followed ? L10n("macPodcastExplore.followed") : result.explicit ? L10n("macPodcastExplore.explicit") : result.genres.joined(separator: " · "))
                                            .font(.caption2).foregroundStyle(MacTheme.muted).lineLimit(1)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }.padding(10)
                                    .background(selected?.id == result.id ? MacTheme.accent.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 10))
                            }.buttonStyle(.plain)
                        }
                        if page?.results.isEmpty == true && !loading { Text(L10n("macPodcastExplore.noResults")).foregroundStyle(MacTheme.muted).padding() }
                    }
                }.frame(minWidth: 280, idealWidth: 320)
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let selected {
                            Text(selected.title).font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
                            if previewing { ProgressView(L10n("macPodcastExplore.previewing")) }
                            if let preview {
                                Text(L10n("macPodcastExplore.previewEpisodes", preview.author, preview.episodeCount)).foregroundStyle(MacTheme.muted)
                                Text(MacPodcastArticle.render(preview.description, duration: 0)).textSelection(.enabled)
                                Text(L10n("macPodcastExplore.latestEpisodes")).font(.headline)
                                ForEach(Array(preview.latestEpisodes.enumerated()), id: \.offset) { _, episode in
                                    Text(episode.title).font(.callout).fixedSize(horizontal: false, vertical: true)
                                }
                                Button(adding ? L10n("macPodcastExplore.following") : preview.followed ? L10n("macPodcastExplore.openShow") : L10n("macPodcastExplore.followShow")) { Task { await follow(selected, preview: preview) } }
                                    .buttonStyle(.borderedProminent)
                                    .disabled(adding || (!canAdd && preview.catalogPodcastID == nil))
                                if !canAdd && preview.catalogPodcastID == nil { Text(L10n("macPodcastExplore.addDisabledByAdmin")).font(.caption).foregroundStyle(MacTheme.muted) }
                            }
                            if let previewError { Text(previewError).foregroundStyle(MacTheme.warning) }
                        } else {
                            ContentUnavailableView(L10n("macPodcastExplore.discoverPrompt"), systemImage: "antenna.radiowaves.left.and.right", description: Text(L10n("macPodcastExplore.discoverPromptDesc")))
                        }
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(minWidth: 330)
            }
        }.padding(24).frame(width: 840, height: 620)
        .task { do { canAdd = try await client.canAddPodcasts() } catch { self.error = MacErrorText.message(for: error) } }
        .task(id: "\(query)|\(region)|\(retry)") {
            let cleanQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
            if cleanQuery.isEmpty, let cached = PodcastDiscoveryCache.shared.get(region: region) {
                page = cached
                loading = false
                error = nil
                return
            }
            page = nil; error = nil; loading = true; selected = nil
            do {
                if !cleanQuery.isEmpty {
                    try await Task.sleep(for: .milliseconds(350))
                }
                let result = try await client.podcastDirectory(query: cleanQuery, region: region)
                guard !Task.isCancelled else { return }
                page = result; loading = false
            } catch {
                guard !Task.isCancelled else { return }
                self.error = MacErrorText.message(for: error); loading = false
            }
        }
        .task(id: selected?.id) {
            preview = nil; previewError = nil
            guard let selected else { return }
            previewing = true
            do {
                let result = try await client.previewPodcast(feedURL: selected.feedURL)
                guard !Task.isCancelled else { return }
                preview = result; previewing = false
            } catch {
                guard !Task.isCancelled else { return }
                previewError = MacErrorText.message(for: error); previewing = false
            }
        }
    }

    private func follow(_ selected: PodcastDirectoryResult, preview: PodcastFeedPreview) async {
        adding = true; previewError = nil
        defer { adding = false }
        do {
            let id: String
            if let existing = preview.catalogPodcastID {
                if !preview.followed { try await client.setPodcastFollowed(id: existing, followed: true) }
                id = existing
            } else {
                id = try await client.addPodcast(feedURL: selected.feedURL, itunesID: selected.itunesID).podcast.id
            }
            onFollowed(id); dismiss()
        } catch { previewError = MacErrorText.message(for: error) }
    }
}
