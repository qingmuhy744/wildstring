import CoreNetwork
import SwiftUI
import UIKit

/// Provider evidence for one track: trigger a bounded lookup, review candidate
/// fields and confirm them (or one candidate cover) explicitly.
@MainActor
struct MetadataSuggestionsView: View {
    let client: WildstringClient
    let track: Track

    @Environment(\.dismiss) private var dismiss
    @State private var results: ProviderSuggestions?
    @State private var currentVersion = 0
    @State private var missingOnly = true
    @State private var forceLookup = false
    @State private var chosen: [String: Set<String>] = [:]
    @State private var pendingApply: PendingApply?
    @State private var pendingCover: ProviderSuggestion?
    @State private var showingReview = false
    @State private var isWorking = false
    @State private var message: String?
    @State private var messageIsError = false

    private struct PendingApply {
        let suggestionID: String
        let version: Int
        let fields: [String]
    }

    private static let fieldOrder = [
        "title", "artists", "album", "album_artists", "vocalists", "lyricists",
        "composers", "arrangers", "track_number", "disc_number", "release_date",
        "tags", "description",
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle(L10n("suggestions.missingOnly"), isOn: $missingOnly)
                    Toggle(L10n("suggestions.forceLookup"), isOn: $forceLookup)
                    Button(L10n("suggestions.updateMetadata")) { Task { await refresh() } }
                        .disabled(isWorking)
                } header: {
                    Text(track.title)
                } footer: {
                    Text(L10n("suggestions.footerNotice"))
                }

                if let jobs = results?.jobs, !jobs.isEmpty {
                    Section(L10n("suggestions.queryTasks")) {
                        ForEach(jobs.prefix(3)) { job in
                            HStack {
                                Text(L10n("suggestions.task"))
                                Spacer()
                                Text(statusText(job.status))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if let pending = pendingSuggestions, !pending.isEmpty {
                    ForEach(pending) { suggestion in
                        suggestionSection(suggestion)
                    }
                } else if results != nil && !isWorking {
                    Section {
                        Text(L10n("suggestions.emptyCandidates"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                if let message {
                    Section {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(messageIsError ? .red : .green)
                    }
                }
            }
            .navigationTitle(L10n("suggestions.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(L10n("suggestions.close")) { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L10n("suggestions.batchReview")) { showingReview = true }
                }
            }
            .sheet(isPresented: $showingReview) {
                MetadataReviewView(client: client, initialTrack: track)
            }
            .task { await poll() }
            .alert(
                L10n("suggestions.applyTitle"),
                isPresented: Binding(
                    get: { pendingApply != nil },
                    set: { if !$0 { pendingApply = nil } }
                ),
                presenting: pendingApply
            ) { pending in
                Button(L10n("suggestions.confirmApply")) { Task { await apply(pending) } }
                Button(L10n("suggestions.cancel"), role: .cancel) {}
            } message: { pending in
                Text(L10n("suggestions.applyFieldsCountNotice", pending.fields.count))
            }
            .alert(
                L10n("suggestions.adoptCoverTitle"),
                isPresented: Binding(
                    get: { pendingCover != nil },
                    set: { if !$0 { pendingCover = nil } }
                ),
                presenting: pendingCover
            ) { suggestion in
                Button(L10n("suggestions.confirmAdoptCover")) { Task { await applyCover(suggestion) } }
                Button(L10n("suggestions.cancel"), role: .cancel) {}
            } message: { _ in
                Text(L10n("suggestions.coverNotice"))
            }
        }
    }

    private var pendingSuggestions: [ProviderSuggestion]? {
        results?.suggestions.filter { $0.status == "pending" }
    }

    private func suggestionSection(_ suggestion: ProviderSuggestion) -> some View {
        let stale = suggestion.metadataVersion != currentVersion
        let selected = chosen[suggestion.id] ?? []
        let keys = orderedKeys(suggestion)
        return Section {
            if stale {
                Text(L10n("suggestions.trackChangedStale"))
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            ForEach(keys, id: \.self) { key in
                Button {
                    Haptics.selection()
                    var values = chosen[suggestion.id] ?? []
                    if values.contains(key) {
                        values.remove(key)
                    } else {
                        values.insert(key)
                    }
                    chosen[suggestion.id] = values
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(
                            systemName: selected.contains(key)
                                ? "checkmark.circle.fill" : "circle"
                        )
                        .foregroundStyle(selected.contains(key) ? Color.wildAccent : .secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(fieldLabel(key))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(suggestion.fields[key]?.display ?? "")
                                .font(.footnote)
                                .foregroundStyle(.primary)
                        }
                    }
                }
                .disabled(stale || isWorking)
            }
            if suggestion.coverURL != nil, !stale {
                SuggestionCoverPreview(client: client, suggestionID: suggestion.id)
                    .frame(maxWidth: .infinity, alignment: .center)
                Button(L10n("suggestions.adoptCoverButton")) { pendingCover = suggestion }
                    .disabled(isWorking)
            }
            Button(L10n("suggestions.applySelectedButton")) {
                pendingApply = PendingApply(
                    suggestionID: suggestion.id,
                    version: suggestion.metadataVersion,
                    fields: keys.filter { selected.contains($0) }
                )
            }
            .disabled(stale || isWorking || selected.isEmpty)
        } header: {
            HStack {
                Text(providerName(suggestion.provider))
                if let score = suggestion.match?.score {
                    Spacer()
                    Text(L10n("suggestions.matchScore", Int((score * 100).rounded())))
                }
            }
        }
    }

    private func orderedKeys(_ suggestion: ProviderSuggestion) -> [String] {
        let known = Self.fieldOrder.filter { suggestion.fields[$0] != nil }
        let extra = suggestion.fields.keys.filter { !Self.fieldOrder.contains($0) }.sorted()
        return known + extra
    }

    private func fieldLabel(_ key: String) -> String {
        switch key {
        case "title": return L10n("suggestions.fieldTitle")
        case "artists": return L10n("suggestions.fieldArtists")
        case "album": return L10n("suggestions.fieldAlbum")
        case "album_artists": return L10n("suggestions.fieldAlbumArtists")
        case "vocalists": return L10n("suggestions.fieldVocalists")
        case "lyricists": return L10n("suggestions.fieldLyricists")
        case "composers": return L10n("suggestions.fieldComposers")
        case "arrangers": return L10n("suggestions.fieldArrangers")
        case "track_number": return L10n("suggestions.fieldTrackNumber")
        case "disc_number": return L10n("suggestions.fieldDiscNumber")
        case "release_date": return L10n("suggestions.fieldReleaseDate")
        case "tags": return L10n("suggestions.fieldTags")
        case "description": return L10n("suggestions.fieldDescription")
        default: return key
        }
    }

    private func providerName(_ id: String) -> String {
        let name = results?.providerNames[id] ?? ""
        return name.isEmpty ? id : name
    }

    private func statusText(_ status: String?) -> String {
        switch status {
        case "queued": return L10n("suggestions.statusQueued")
        case "running": return L10n("suggestions.statusRunning")
        case "completed": return L10n("suggestions.statusCompleted")
        case "completed_with_errors": return L10n("suggestions.statusCompletedWithErrors")
        case "stale": return L10n("suggestions.statusStale")
        case "failed": return L10n("suggestions.statusFailed")
        case "interrupted": return L10n("suggestions.statusInterrupted")
        case "review": return L10n("suggestions.statusReview")
        case nil: return "—"
        default: return status ?? "—"
        }
    }

    private func poll() async {
        await load()
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3))
            if Task.isCancelled {
                return
            }
            if !isWorking {
                await load()
            }
        }
    }

    private func load() async {
        do {
            async let suggestions = client.providerSuggestions(trackID: track.id)
            async let metadata = client.manageMetadata(trackID: track.id)
            let (loaded, record) = try await (suggestions, metadata)
            results = loaded
            currentVersion = record.version
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func refresh() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let queued = try await client.refreshProviderMetadata(
                trackID: track.id,
                mode: missingOnly ? "missing" : "all",
                force: forceLookup
            )
            message = L10n("suggestions.queuedMessage", queued.queued)
            messageIsError = false
            await load()
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func apply(_ pending: PendingApply) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await client.applyProviderSuggestion(
                id: pending.suggestionID,
                version: pending.version,
                fields: pending.fields
            )
            chosen[pending.suggestionID] = []
            message = L10n("suggestions.appliedMessage")
            messageIsError = false
            await load()
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = L10n("suggestions.trackChangedRefresh")
            messageIsError = true
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func applyCover(_ suggestion: ProviderSuggestion) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            try await client.applyProviderCover(
                suggestionID: suggestion.id,
                version: suggestion.metadataVersion
            )
            message = L10n("suggestions.coverSavedMessage")
            messageIsError = false
            await load()
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = L10n("suggestions.trackChangedRefresh")
            messageIsError = true
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }
}

/// Candidate cover fetched through the authenticated session and kept small.
@MainActor
private struct SuggestionCoverPreview: View {
    let client: WildstringClient
    let suggestionID: String

    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if failed {
                Text(L10n("suggestions.coverPreviewUnavailable"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .frame(width: 180, height: 180)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .task(id: suggestionID) { await load() }
    }

    private func load() async {
        let key = "suggestion:\(suggestionID)"
        if let cached = CoverCache.shared.image(for: key) {
            image = cached
            return
        }
        do {
            let data = try await client.providerCoverPreview(suggestionID: suggestionID)
            guard let loaded = UIImage(data: data) else {
                failed = true
                return
            }
            CoverCache.shared.store(loaded, for: key)
            image = loaded
        } catch {
            failed = true
        }
    }
}
