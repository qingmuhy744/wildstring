import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct PodcastDiscoverView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var query = ""
    @State private var region = ""
    @State private var page: PodcastDirectoryPage?
    @State private var selectedResult: PodcastDirectoryResult?
    @State private var preview: PodcastFeedPreview?
    @State private var loading = true
    @State private var previewing = false
    @State private var following = false
    @State private var canAdd = false
    @State private var errorMessage: String?
    @State private var previewError: String?
    @State private var retryToken = 0

    var body: some View {
        List {
            if query.isEmpty {
                Section {
                    Picker(L10n("podcastDiscover.region"), selection: $region) {
                        Text(L10n("podcastDiscover.regionDefault")).tag("")
                        Text(L10n("podcastDiscover.regionCN")).tag("cn")
                        Text(L10n("podcastDiscover.regionHK")).tag("hk")
                        Text(L10n("podcastDiscover.regionTW")).tag("tw")
                        Text(L10n("podcastDiscover.regionUS")).tag("us")
                        Text(L10n("podcastDiscover.regionJP")).tag("jp")
                        Text(L10n("podcastDiscover.regionGB")).tag("gb")
                    }
                }
            }

            if let errorMessage {
                Section {
                    HStack {
                        Text(errorMessage).foregroundStyle(.red)
                        Spacer()
                        Button(L10n("podcastDiscover.retry")) { retryToken += 1 }
                    }
                }
            }

            if let page, !page.failedRegions.isEmpty {
                Section {
                    Text(L10n("podcastDiscover.failedRegions", page.failedRegions.map(\.region).joined(separator: ", ")))
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            Section(query.isEmpty ? L10n("podcastDiscover.topCharts") : L10n("podcastDiscover.searchResults")) {
                if loading && (page == nil || page?.results.isEmpty == true) {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(L10n("podcastDiscover.loadingDirectory")).foregroundStyle(.secondary)
                    }
                } else if let results = page?.results, !results.isEmpty {
                    ForEach(results) { result in
                        Button {
                            selectedResult = result
                            Task { await loadPreview(for: result) }
                        } label: {
                            HStack(spacing: 12) {
                                AsyncImage(url: URL(string: result.artworkURL)) { image in
                                    image.resizable().scaledToFill()
                                } placeholder: {
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(Color(.secondarySystemFill))
                                        .overlay(Image(systemName: "antenna.radiowaves.left.and.right").foregroundStyle(.secondary))
                                }
                                .frame(width: 52, height: 52)
                                .clipShape(RoundedRectangle(cornerRadius: 8))

                                VStack(alignment: .leading, spacing: 3) {
                                    Text(result.title)
                                        .font(.subheadline)
                                        .fontWeight(.medium)
                                        .lineLimit(2)
                                        .foregroundStyle(Color.primary)
                                    Text(result.author)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                    Text(result.followed ? L10n("podcastDiscover.followed") : result.genres.joined(separator: " · "))
                                        .font(.caption2)
                                        .foregroundStyle(result.followed ? Color.accentColor : .secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                } else if !loading {
                    ContentUnavailableView(
                        query.isEmpty ? L10n("podcastDiscover.emptyChartsTitle") : L10n("podcastDiscover.noResultsTitle"),
                        systemImage: "magnifyingglass",
                        description: Text(query.isEmpty ? L10n("podcastDiscover.emptyChartsDescription") : L10n("podcastDiscover.noResultsDescription"))
                    )
                }
            }
        }
        .navigationTitle(L10n("podcastDiscover.title"))
        .searchable(text: $query, prompt: Text(L10n("podcastDiscover.searchPrompt")))
        .sheet(item: $selectedResult) { result in
            NavigationStack {
                previewSheet(result: result)
            }
        }
        .task {
            do {
                canAdd = try await client.canAddPodcasts()
            } catch {
                // Ignore failure to fetch policy
            }
        }
        .task(id: "\(query)|\(region)|\(retryToken)") {
            await fetchDirectory()
        }
    }

    @ViewBuilder
    private func previewSheet(result: PodcastDirectoryResult) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    AsyncImage(url: URL(string: result.artworkURL)) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 10)
                            .fill(Color(.secondarySystemFill))
                    }
                    .frame(width: 72, height: 72)
                    .clipShape(RoundedRectangle(cornerRadius: 10))

                    VStack(alignment: .leading, spacing: 4) {
                        Text(result.title)
                            .font(.headline)
                            .lineLimit(2)
                        Text(result.author)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if let count = preview?.episodeCount {
                            Text(L10n("podcastDiscover.episodeCount", count))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if previewing {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(L10n("podcastDiscover.readingDescription")).font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }

                if let preview {
                    if !preview.description.isEmpty {
                        Text(preview.description)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    Button {
                        Task { await followOrOpen(result: result, preview: preview) }
                    } label: {
                        HStack {
                            Spacer()
                            if following {
                                ProgressView()
                            } else {
                                Text(preview.followed ? L10n("podcastDiscover.followedOpen") : L10n("podcastDiscover.followShow"))
                                    .fontWeight(.semibold)
                            }
                            Spacer()
                        }
                        .padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(following || (!canAdd && preview.catalogPodcastID == nil))

                    if !canAdd && preview.catalogPodcastID == nil {
                        Text(L10n("podcastDiscover.addDisabledNotice"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    if !preview.latestEpisodes.isEmpty {
                        Divider()
                        Text(L10n("podcastDiscover.latestEpisodes"))
                            .font(.headline)
                        ForEach(Array(preview.latestEpisodes.prefix(5).enumerated()), id: \.offset) { _, ep in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ep.title)
                                    .font(.subheadline)
                                    .lineLimit(2)
                                if let pub = ep.pubDate, !pub.isEmpty {
                                    Text(pub)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }

                if let previewError {
                    Text(previewError)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            .padding(20)
        }
        .navigationTitle(L10n("podcastDiscover.previewTitle"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(L10n("podcastDiscover.done")) { selectedResult = nil }
            }
        }
    }

    private func fetchDirectory() async {
        let cleanQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleanQuery.isEmpty, let cached = PodcastDiscoveryCache.shared.get(region: region) {
            page = cached
            loading = false
            errorMessage = nil
            return
        }

        loading = true
        errorMessage = nil
        do {
            let fetched = try await client.podcastDirectory(
                query: cleanQuery,
                region: region
            )
            if cleanQuery.isEmpty {
                PodcastDiscoveryCache.shared.set(region: region, page: fetched)
            }
            page = fetched
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
        loading = false
    }

    private func loadPreview(for result: PodcastDirectoryResult) async {
        previewing = true
        previewError = nil
        preview = nil
        do {
            preview = try await client.previewPodcast(feedURL: result.feedURL)
        } catch {
            previewError = L10n("podcastDiscover.previewFailed", ErrorText.message(for: error))
        }
        previewing = false
    }

    private func followOrOpen(result: PodcastDirectoryResult, preview: PodcastFeedPreview) async {
        following = true
        defer { following = false }
        do {
            if let catID = preview.catalogPodcastID {
                try await client.setPodcastFollowed(id: catID, followed: true)
            } else {
                _ = try await client.addPodcast(feedURL: result.feedURL, itunesID: result.itunesID)
            }
            selectedResult = nil
        } catch {
            previewError = L10n("podcastDiscover.actionFailed", ErrorText.message(for: error))
        }
    }
}
