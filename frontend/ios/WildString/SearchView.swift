import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct SearchView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var tracksSelected = TrackSelection()
    @State private var query = ""
    @State private var tracks: [Track] = []
    @State private var total = 0
    @State private var loadedOffset = 0
    @State private var isSearching = false
    @State private var hasSearched = false
    @State private var errorMessage: String?
    @State private var showingAssistant = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(tracks) { track in
                    TrackActionRow(client: client, playback: playback, track: track, play: {
                        play(track)
                    }) {
                        TrackRow(
                            client: client,
                            track: track,
                            isCurrent: playback.currentItem?.trackID == track.id
                        )
                    }
                    .onAppear {
                        if track.id == tracks.last?.id, loadedOffset < total {
                            Task { await loadNextSearchPage() }
                        }
                    }
                }
                if isSearching {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                    .listRowSeparator(.hidden)
                }
                if let errorMessage, !tracks.isEmpty {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .listStyle(.plain)
            .overlay {
                if !hasSearched, query.trimmingCharacters(in: .whitespaces).isEmpty {
                    ContentUnavailableView(
                        L10n("searchView.emptyTitle"),
                        systemImage: "magnifyingglass",
                        description: Text(L10n("searchView.emptyDescription"))
                    )
                } else if hasSearched, tracks.isEmpty, !isSearching {
                    if let errorMessage {
                        ContentUnavailableView {
                            Label(L10n("favoritesView.loadFailed"), systemImage: "exclamationmark.circle")
                        } description: {
                            Text(errorMessage)
                        } actions: {
                            Button(L10n("notifications.retry")) { Task { await runSearch() } }
                        }
                    } else {
                        ContentUnavailableView.search(text: query)
                    }
                }
            }
            .modifier(TrackSelectionControls(client: client, selection: tracksSelected) {
                let text = query.trimmingCharacters(in: .whitespaces)
                let loader = PagedListModel<Track> { limit, offset in
                    try await client.tracks(limit: limit, offset: offset, query: text)
                }
                return try await loader.allItems()
            })
            .navigationTitle(L10n("searchView.title"))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingAssistant = true
                    } label: {
                        Label(L10n("searchView.aiSearch"), systemImage: "sparkles")
                    }
                }
            }
            .sheet(isPresented: $showingAssistant) {
                AssistantView(client: client)
            }
            .searchable(text: $query, prompt: Text(L10n("searchView.prompt")))
            .task(id: query) { tracksSelected.finish(); await runSearch() }
            .onDisappear { playback.cancelMusicSelection() }
            .task { await openAssistantForDemoIfNeeded() }
            .miniPlayer(playback, client: client)
        }
    }

    private func play(_ track: Track) {
        guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
        let token = playback.beginMusicSelection()
        let text = query.trimmingCharacters(in: .whitespaces)
        let library = client.selectedLibrary()
        let sourceTotal = total
        guard index < sourceTotal else { errorMessage = L10n("playback.collectionChanged"); return }
        let start = sourceTotal > PlaybackService.musicQueueLimit ? index : 0
        let count = min(PlaybackService.musicQueueLimit, sourceTotal - start)
        guard count > 0 else { return }
        Task {
            do {
                let window: [Track]
                if start + count <= tracks.count {
                    window = Array(tracks[start..<(start + count)])
                } else {
                    let page = try await client.tracks(limit: count, offset: start, query: text)
                    guard playback.isCurrentMusicSelection(token), client.selectedLibrary() == library else { return }
                    guard page.total == sourceTotal, page.items.count == count else { errorMessage = L10n("playback.collectionChanged"); return }
                    window = page.items
                }
                guard playback.isCurrentMusicSelection(token), client.selectedLibrary() == library else { return }
                guard window[index - start].id == track.id else { errorMessage = L10n("playback.collectionChanged"); return }
                playback.play(items: window.map(\.playbackItem), startingAt: index - start, sourceCount: sourceTotal)
            } catch {
                guard playback.isCurrentMusicSelection(token) else { return }
                errorMessage = ErrorText.message(for: error)
            }
        }
    }

    private func openAssistantForDemoIfNeeded() async {
        #if DEBUG
            guard ProcessInfo.processInfo.environment["WILDSTRING_DEMO_OPEN_ASSISTANT"] == "1"
            else { return }
            try? await Task.sleep(for: .seconds(1))
            showingAssistant = true
        #endif
    }

    private func loadNextSearchPage() async {
        guard !isSearching, loadedOffset < total else { return }
        let requested = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let offset = loadedOffset
        isSearching = true
        defer {
            if query.trimmingCharacters(in: .whitespacesAndNewlines) == requested { isSearching = false }
        }
        do {
            let page = try await client.tracks(limit: 100, offset: offset, query: requested)
            guard !Task.isCancelled, requested == query.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
            var seen = Set(tracks.map(\.id))
            tracks.append(contentsOf: page.items.filter { seen.insert($0.id).inserted })
            loadedOffset = page.items.isEmpty ? page.total : offset + page.items.count
            total = page.total
            errorMessage = nil
        } catch {
            if requested == query.trimmingCharacters(in: .whitespacesAndNewlines) { errorMessage = ErrorText.message(for: error) }
        }
    }

    private func runSearch() async {
        playback.cancelMusicSelection()
        tracks = []
        loadedOffset = 0
        total = 0
        isSearching = false
        let text = query.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else {
            tracks = []
            hasSearched = false
            errorMessage = nil
            return
        }
        do {
            try await Task.sleep(for: .milliseconds(320))
        } catch {
            return
        }
        guard !Task.isCancelled else { return }
        isSearching = true
        defer { isSearching = false }
        do {
            let page = try await client.tracks(limit: 100, query: text)
            guard !Task.isCancelled else { return }
            tracks = page.items
            total = page.total
            loadedOffset = page.items.count
            hasSearched = true
            errorMessage = nil
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = ErrorText.message(for: error)
            hasSearched = true
        }
    }
}
