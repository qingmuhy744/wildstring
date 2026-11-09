import CoreNetwork
import SwiftUI
import UIKit

/// Album review workbench: compare current values with provider evidence,
/// select fields, then apply the chosen subset in one transaction.
@MainActor
struct MetadataReviewView: View {
    let client: WildstringClient
    var initialTrack: Track?

    @Environment(\.dismiss) private var dismiss
    @State private var albums: [ReviewAlbum] = []
    @State private var albumTotal = 0
    @State private var page: ReviewPage?
    @State private var tracks: [ReviewTrack] = []
    @State private var activeID = ""
    @State private var choices: [String: ReviewChoice] = [:]
    @State private var showAlbums = false
    @State private var showSongs = false
    @State private var showSources = false
    @State private var albumFilter = ""
    @State private var onlyChanges = true
    @State private var showOriginal = false
    @State private var tab = ReviewTab.fields
    @State private var coverDraft: Draft?
    @State private var coverAll = false
    @State private var coverReady = false
    @State private var coverFailed = false
    @State private var rejectionNotice: String?
    @State private var conflicts: Set<String> = []
    @State private var isWorking = false
    @State private var message: String?
    @State private var messageIsError = false
    @State private var operationKey = UUID().uuidString.lowercased()
    @State private var operationSignature = ""
    @State private var pageOffset = 0

    private struct ReviewChoice {
        var sourceID: String
        var fields: Set<String>
    }

    private enum ReviewTab: CaseIterable {
        case fields
        case cover

        var label: String {
            switch self {
            case .fields: L10n("metaReview.tabFields")
            case .cover: L10n("metaReview.tabCover")
            }
        }
    }

    private static let fieldOrder = [
        "title", "artists", "album", "album_artists", "vocalists", "lyricists",
        "composers", "arrangers", "track_number", "disc_number", "track_total",
        "disc_total", "release_date", "original_date", "genres", "external_ids",
        "tags", "description",
    ]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        header
                        if showSongs {
                            songPicker
                        }
                        if let current {
                            activeTrack(current)
                        } else if page != nil, !isWorking {
                            Text(L10n("metaReview.noCandidatesInAlbum"))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        if let message {
                            Text(message)
                                .font(.caption)
                                .foregroundStyle(messageIsError ? .red : .green)
                        }
                    }
                    .padding(16)
                }
                bottomBar
            }
            .navigationTitle(L10n("metaReview.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(L10n("metaReview.close")) { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L10n("metaReview.reload")) {
                        Task { await reloadKeepingActive() }
                    }
                    .disabled(isWorking)
                }
            }
            .task { await initialLoad() }
            .sheet(isPresented: $showAlbums) {
                albumPicker
            }
            .sheet(isPresented: $showSources) {
                sourcePicker
            }
        }
    }

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L10n("metaReview.headerHint"))
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                Button(L10n("metaReview.selectAlbum")) { showAlbums = true }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                Button(L10n("metaReview.selectChanges")) {
                    choices = Dictionary(
                        uniqueKeysWithValues: tracks.map { ($0.id, defaultChoice($0)) }
                    )
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isWorking || tracks.isEmpty)
                Button(L10n("metaReview.clear")) {
                    choices = choices.mapValues { ReviewChoice(sourceID: $0.sourceID, fields: []) }
                }
                .buttonStyle(.plain)
                .font(.footnote)
                .disabled(isWorking)
            }
            Text(page?.albumID == nil ? L10n("metaReview.noAlbumPending") : current?.album ?? L10n("metaReview.pendingAlbum"))
                .font(.headline)
                .lineLimit(1)
            Text(L10n("metaReview.trackCountPageSummary", page?.total ?? 0, tracks.count))
                .font(.caption)
                .foregroundStyle(.secondary)
            Button(showSongs ? L10n("metaReview.collapseSongList") : L10n("metaReview.selectSongsCount", selectedTracks.count)) {
                showSongs.toggle()
            }
            .font(.footnote)
        }
    }

    private var songPicker: some View {
        VStack(spacing: 0) {
            ForEach(tracks) { track in
                HStack(spacing: 10) {
                    Button {
                        let fields = choices[track.id]?.fields.isEmpty == false
                            ? []
                            : defaultChoice(track).fields
                        choose(track.id, fields: fields)
                    } label: {
                        Image(
                            systemName: choices[track.id]?.fields.isEmpty == false
                                ? "checkmark.circle.fill" : "circle"
                        )
                        .foregroundStyle(
                            choices[track.id]?.fields.isEmpty == false
                                ? Color.wildAccent : .secondary
                        )
                    }
                    .buttonStyle(.plain)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(track.title).font(.subheadline).lineLimit(1)
                        Text(
                            conflicts.contains(track.id)
                                ? L10n("metaReview.conflictNotice")
                                : L10n("metaReview.selectedFieldsCount", choices[track.id]?.fields.count ?? 0)
                        )
                        .font(.caption2)
                        .foregroundStyle(conflicts.contains(track.id) ? .red : .secondary)
                    }
                    Spacer()
                }
                .padding(.vertical, 6)
                .contentShape(Rectangle())
                .onTapGesture {
                    activeID = track.id
                    showSongs = false
                    resetCover()
                }
                Divider()
            }
            if let page, page.total > 500 {
                HStack {
                    Button(L10n("metaReview.previousPage")) {
                        Task {
                            await loadPage(
                                albumID: page.albumID,
                                offset: max(0, pageOffset - 500)
                            )
                        }
                    }
                    .disabled(isWorking || pageOffset == 0)
                    Spacer()
                    Button(L10n("metaReview.nextPage")) {
                        Task {
                            await loadPage(
                                albumID: page.albumID,
                                offset: pageOffset + 500
                            )
                        }
                    }
                    .disabled(isWorking || pageOffset + 500 >= page.total)
                }
                .font(.footnote)
            }
        }
    }

    @ViewBuilder
    private func activeTrack(_ current: ReviewTrack) -> some View {
        let source = candidate(for: current)
        VStack(alignment: .leading, spacing: 8) {
            Text(current.title).font(.title3.bold())
            Text(current.artists.joined(separator: " / "))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(alignment: .top) {
                Button {
                    showSources = true
                } label: {
                    Text(source.map { candidateLabel($0, track: current) } ?? L10n("metaReview.selectCandidateSource"))
                        .font(.footnote)
                        .multilineTextAlignment(.leading)
                        .lineLimit(3)
                }
                .buttonStyle(.plain)
                Spacer()
                Button(L10n("metaReview.queryNewMetadata")) {
                    Task { await refreshCandidates(current) }
                }
                .font(.footnote)
                .disabled(isWorking)
            }
            if let source, (source.duplicateCount ?? 1) > 1 {
                Text(L10n("metaReview.duplicateCandidatesMerged", source.duplicateCount ?? 1))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Picker(L10n("metaReview.content"), selection: $tab) {
                ForEach(ReviewTab.allCases, id: \.self) { tab in
                    Text(tab.label).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            if tab == .fields {
                fieldsSection(current, source: source)
            } else {
                coverSection(current, source: source)
            }
        }
    }

    @ViewBuilder
    private func fieldsSection(_ current: ReviewTrack, source: ReviewCandidate?) -> some View {
        Toggle(L10n("metaReview.onlyChangedFields"), isOn: $onlyChanges)
            .font(.footnote)
        if let source {
            Text(
                source.metadataVersion != current.metadataVersion
                    ? L10n("metaReview.metadataVersionExpired", source.metadataVersion)
                    : L10n("metaReview.metadataVersion", source.metadataVersion)
            )
            .font(.caption2)
            .foregroundStyle(
                source.metadataVersion != current.metadataVersion ? .orange : .secondary
            )
            if let url = source.sourceURL.flatMap(URL.init(string:)) {
                Link(L10n("metaReview.viewSourceEvidence"), destination: url).font(.caption)
            }
        } else {
            Text(L10n("metaReview.noValidCandidates"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if let source {
            let stale = source.metadataVersion != current.metadataVersion
            ForEach(visibleFieldKeys(source, track: current), id: \.self) { key in
                fieldCard(key, source: source, current: current, stale: stale)
            }
        }
        DisclosureGroup(L10n("metaReview.originalValuesAndMatch"), isExpanded: $showOriginal) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(current.original.keys.sorted(), id: \.self) { key in
                    Text(L10n("metaReview.fieldWithColon", fieldLabel(key), current.original[key]?.display ?? "—"))
                        .font(.caption2)
                }
                if let match = source?.match {
                    let method = match.method ?? L10n("metaReview.unknown")
                    let text = match.score.map { L10n("metaReview.matchMethodWithScore", method, Int(($0 * 100).rounded())) }
                        ?? L10n("metaReview.matchMethod", method)
                    Text(text)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
        .font(.footnote)
    }

    private func fieldCard(
        _ key: String,
        source: ReviewCandidate,
        current: ReviewTrack,
        stale: Bool
    ) -> some View {
        let chosen = choices[current.id]?.fields ?? []
        let selected = chosen.contains(key)
        let manual = current.overrides[key] != nil
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button {
                    Haptics.selection()
                    var fields = chosen
                    if selected { fields.remove(key) } else { fields.insert(key) }
                    choose(current.id, fields: fields, sourceID: source.id)
                } label: {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.wildAccent : .secondary)
                }
                .buttonStyle(.plain)
                .disabled(stale || isWorking)
                Text(fieldLabel(key)).font(.caption.bold())
                Spacer()
                if manual {
                    Text(L10n("metaReview.manualValue")).font(.caption2).foregroundStyle(Color.wildAccent)
                }
            }
            Text(L10n("metaReview.currentValue")).font(.caption2).foregroundStyle(.secondary)
            Text(current.current[key]?.display ?? "—")
                .font(.caption)
            Divider()
            Text(L10n("metaReview.suggestedValue")).font(.caption2).foregroundStyle(Color.wildAccent)
            Text(source.fields[key]?.display ?? "—")
                .font(.caption)
            Button(
                selected
                    ? L10n("metaReview.unselectSameFieldOnPage")
                    : L10n("metaReview.selectSameFieldOnPage")
            ) {
                applyFieldToPage(key, selected: !selected)
            }
            .font(.caption2)
            .disabled(isWorking)
        }
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func coverSection(_ current: ReviewTrack, source: ReviewCandidate?) -> some View {
        Toggle(L10n("metaReview.applyCoverToAlbumTracksOnPage", coverAll ? tracks.count : 1), isOn: $coverAll)
            .font(.footnote)
            .onChange(of: coverAll) { _, _ in
                resetCover()
            }
        HStack(spacing: 12) {
            VStack(spacing: 4) {
                Text(L10n("metaReview.currentCover")).font(.caption2).foregroundStyle(.secondary)
                if current.hasCover {
                    CoverImage(client: client, trackID: current.id, size: 140)
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(.secondarySystemBackground))
                        .frame(width: 140, height: 140)
                        .overlay(Text(L10n("metaReview.noCover")).font(.caption2).foregroundStyle(.secondary))
                }
            }
            VStack(spacing: 4) {
                Text(L10n("metaReview.targetCover")).font(.caption2).foregroundStyle(.secondary)
                if let coverDraft {
                    ReviewCoverPreview(client: client, draftID: coverDraft.id) { ready in
                        coverReady = ready
                        coverFailed = !ready
                    }
                    .frame(width: 140, height: 140)
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(.secondarySystemBackground))
                        .frame(width: 140, height: 140)
                        .overlay(Text(L10n("metaReview.notFrozen")).font(.caption2).foregroundStyle(.secondary))
                }
            }
        }
        .frame(maxWidth: .infinity)
        Button(L10n("metaReview.freezeAndPreviewCover")) {
            Task { await freezeCover(current, source: source) }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(
            isWorking || source?.coverURL == nil
                || source?.metadataVersion != current.metadataVersion
        )
        if coverFailed {
            Text(L10n("metaReview.coverFailedNotice"))
                .font(.caption)
                .foregroundStyle(.red)
        }
    }

    private var bottomBar: some View {
        let fieldCount = selectedTracks.reduce(0) { $0 + (choices[$1.id]?.fields.count ?? 0) }
        return VStack(spacing: 6) {
            Text(
                coverDraft != nil
                    ? L10n("metaReview.bottomBarSummaryWithCover", selectedTracks.count, fieldCount)
                    : L10n("metaReview.bottomBarSummary", selectedTracks.count, fieldCount)
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button(L10n("metaReview.skipThisTrack")) {
                    choices[activeID] = ReviewChoice(
                        sourceID: choices[activeID]?.sourceID ?? "",
                        fields: []
                    )
                    resetCover()
                    advance()
                }
                .buttonStyle(.bordered)
                .disabled(isWorking || current == nil)
                Button(L10n("metaReview.acceptSelected")) {
                    Task { await acceptReview(single: false) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    isWorking
                        || (selectedTracks.isEmpty && coverDraft == nil)
                        || (coverDraft != nil && !coverReady)
                )
            }
            if let rejectionNotice {
                Text(rejectionNotice)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 8) {
                Button(L10n("metaReview.rejectCurrentSuggestion")) {
                    Task { await rejectCurrent() }
                }
                .font(.footnote)
                .disabled(isWorking || candidate(for: current) == nil)
                Spacer()
                Button(L10n("metaReview.acceptTrackAndNext")) {
                    Task { await acceptReview(single: true) }
                }
                .font(.footnote)
                .disabled(
                    isWorking
                        || (choices[activeID]?.fields.isEmpty != false && coverDraft == nil)
                        || (coverDraft != nil && (coverAll || !coverReady))
                )
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var albumPicker: some View {
        NavigationStack {
            List {
                TextField(L10n("metaReview.filterAlbums"), text: $albumFilter)
                ForEach(
                    albums.filter {
                        albumFilter.isEmpty
                            || ($0.title + $0.artists.joined()).localizedCaseInsensitiveContains(
                                albumFilter
                            )
                    }
                ) { album in
                    Button {
                        showAlbums = false
                        Task { await loadPage(albumID: album.id) }
                    } label: {
                        HStack {
                            Text(album.title).lineLimit(1)
                            Spacer()
                            Text(L10n("metaReview.trackCount", album.count))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if albums.count < albumTotal {
                    Button(L10n("metaReview.moreAlbums")) {
                        Task { await loadAlbums(append: true) }
                    }
                }
            }
            .navigationTitle(L10n("metaReview.pendingAlbumsTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L10n("metaReview.close")) { showAlbums = false }
                }
            }
            .task { if albums.isEmpty { await loadAlbums() } }
        }
    }

    private var sourcePicker: some View {
        NavigationStack {
            List {
                if let current {
                    ForEach(current.suggestions) { candidate in
                        Button {
                            let fields = defaultFields(candidate, track: current)
                            choices[current.id] = ReviewChoice(
                                sourceID: candidate.id,
                                fields: fields
                            )
                            resetCover()
                            showSources = false
                        } label: {
                            Text(candidateLabel(candidate, track: current))
                                .font(.footnote)
                                .multilineTextAlignment(.leading)
                        }
                    }
                }
            }
            .navigationTitle(L10n("metaReview.candidateSourcesTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L10n("metaReview.close")) { showSources = false }
                }
            }
        }
    }

    // MARK: - Data

    private var current: ReviewTrack? {
        tracks.first { $0.id == activeID }
    }

    private var selectedTracks: [ReviewTrack] {
        tracks.filter { choices[$0.id]?.fields.isEmpty == false }
    }

    private func candidate(for track: ReviewTrack?) -> ReviewCandidate? {
        guard let track else { return nil }
        guard let sourceID = choices[track.id]?.sourceID, !sourceID.isEmpty else {
            return track.suggestions.first {
                $0.metadataVersion == track.metadataVersion
            }
        }
        return track.suggestions.first { $0.id == sourceID }
    }

    private func defaultChoice(_ track: ReviewTrack) -> ReviewChoice {
        let source = track.suggestions.first { $0.metadataVersion == track.metadataVersion }
        return ReviewChoice(
            sourceID: source?.id ?? "",
            fields: source.map { defaultFields($0, track: track) } ?? []
        )
    }

    private func defaultFields(_ source: ReviewCandidate, track: ReviewTrack) -> Set<String> {
        guard source.metadataVersion == track.metadataVersion else { return [] }
        return Set(
            source.fields.keys.filter { key in
                track.overrides[key] == nil && track.current[key] != source.fields[key]
            }
        )
    }

    private func choose(_ trackID: String, fields: Set<String>, sourceID: String? = nil) {
        let existing = choices[trackID] ?? ReviewChoice(sourceID: "", fields: [])
        choices[trackID] = ReviewChoice(
            sourceID: sourceID ?? existing.sourceID,
            fields: fields
        )
    }

    private func applyFieldToPage(_ key: String, selected: Bool) {
        for track in tracks {
            guard let source = candidate(for: track),
                source.metadataVersion == track.metadataVersion,
                source.fields[key] != nil
            else { continue }
            var fields = choices[track.id]?.fields ?? []
            if selected { fields.insert(key) } else { fields.remove(key) }
            choose(track.id, fields: fields, sourceID: source.id)
        }
    }

    private func visibleFieldKeys(
        _ source: ReviewCandidate,
        track: ReviewTrack
    ) -> [String] {
        let keys = Self.fieldOrder.filter { source.fields[$0] != nil }
            + source.fields.keys.filter { !Self.fieldOrder.contains($0) }.sorted()
        guard onlyChanges else { return keys }
        return keys.filter { track.current[$0] != source.fields[$0] }
    }

    private func initialLoad() async {
        await loadAlbums()
        if let initialTrack {
            await loadPage(trackID: initialTrack.id, preferred: initialTrack.id)
        } else if let first = albums.first {
            await loadPage(albumID: first.id)
        }
    }

    private func loadAlbums(append: Bool = false) async {
        do {
            let offset = append ? albums.count : 0
            let value = try await client.reviewAlbums(limit: 100, offset: offset)
            albums = append ? albums + value.items : value.items
            albumTotal = value.total
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func loadPage(
        albumID: String? = nil,
        trackID: String? = nil,
        preferred: String? = nil,
        offset: Int = 0
    ) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let value = try await client.metadataReview(
                albumID: albumID,
                trackID: trackID,
                limit: 500,
                offset: offset
            )
            page = value
            tracks = value.items
            pageOffset = offset
            choices = Dictionary(
                uniqueKeysWithValues: value.items.map { ($0.id, defaultChoice($0)) }
            )
            activeID = preferred.flatMap { id in value.items.first { $0.id == id }?.id }
                ?? value.items.first { defaultChoice($0).fields.isEmpty == false }?.id
                ?? value.items.first?.id
                ?? ""
            conflicts = []
            rejectionNotice = nil
            resetCover()
            message = nil
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func reloadKeepingActive() async {
        let active = activeID
        await loadPage(
            albumID: page?.albumID,
            preferred: active
        )
    }

    private func advance() {
        guard let index = tracks.firstIndex(where: { $0.id == activeID }) else { return }
        activeID = tracks[(index + 1) % max(1, tracks.count)].id
        resetCover()
        message = nil
    }

    private func resetCover() {
        coverDraft = nil
        coverReady = false
        coverFailed = false
    }

    private func freezeCover(_ current: ReviewTrack, source: ReviewCandidate?) async {
        guard let source, let coverURL = source.coverURL, !coverURL.isEmpty else { return }
        guard source.metadataVersion == current.metadataVersion else { return }
        isWorking = true
        defer { isWorking = false }
        resetCover()
        do {
            let targets = (coverAll ? tracks : [current]).map {
                ReviewCoverTarget(trackID: $0.id, metadataVersion: $0.metadataVersion)
            }
            coverDraft = try await client.reviewCoverDraft(
                title: L10n("metaReview.coverDraftTitle", current.album ?? current.title),
                suggestionID: source.id,
                metadataVersion: current.metadataVersion,
                targets: targets
            )
            message = nil
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func refreshCandidates(_ track: ReviewTrack) async {
        isWorking = true
        defer { isWorking = false }
        do {
            let queued = try await client.refreshProviderMetadata(
                trackID: track.id,
                mode: "missing",
                force: false
            )
            message = L10n("metaReview.queuedForRefresh", queued.queued)
            messageIsError = false
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func rejectCurrent() async {
        guard let current, let source = candidate(for: current) else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await client.rejectReview(
                trackID: current.id,
                suggestionID: source.id,
                metadataVersion: current.metadataVersion,
                candidateDigest: source.candidateDigest
            )
            rejectionNotice = L10n("metaReview.rejectionNotice")
            await loadPage(
                albumID: page?.albumID,
                preferred: current.id
            )
            await loadAlbums()
            rejectionNotice = L10n("metaReview.rejectionNotice")
        } catch let error as APIError where error.statusCode == 404 || error.statusCode == 405 {
            message = L10n("metaReview.serverUpgradeRequired")
            messageIsError = true
        } catch let error as APIError where error.statusCode == 409 {
            await reloadKeepingActive()
            message = L10n("metaReview.staleCandidateRefresh")
            messageIsError = true
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func acceptReview(single: Bool) async {
        guard !isWorking else { return }
        let chosen = single
            ? selectedTracks.filter { $0.id == activeID }
            : selectedTracks
        if chosen.isEmpty, coverDraft == nil { return }
        isWorking = true
        defer { isWorking = false }
        do {
            var items: [ReviewAcceptItem] = []
            for track in chosen {
                guard let source = candidate(for: track),
                    let fields = choices[track.id]?.fields,
                    !fields.isEmpty
                else { continue }
                items.append(
                    ReviewAcceptItem(
                        trackID: track.id,
                        suggestionID: source.id,
                        metadataVersion: track.metadataVersion,
                        candidateDigest: source.candidateDigest,
                        fields: Array(fields)
                    )
                )
            }
            let signature = items.map {
                "\($0.trackID):\($0.fields.sorted().joined(separator: ","))"
            }.joined(separator: "|")
                + "|cover:\(coverDraft?.id ?? "")"
                + "|targets:\(coverAll ? "page" : "track")"
            if signature != operationSignature {
                operationSignature = signature
                operationKey = UUID().uuidString.lowercased()
            }
            let nextID: String?
            if single, let index = tracks.firstIndex(where: { $0.id == activeID }) {
                nextID = tracks[(index + 1) % max(1, tracks.count)].id
            } else {
                nextID = nil
            }
            if !items.isEmpty {
                let result = try await client.acceptReview(
                    items: items,
                    coverDraftID: coverDraft?.id,
                    idempotencyKey: operationKey
                )
                guard result.status == "applied" else {
                    conflicts = Set(result.conflicts?.map(\.trackID) ?? [])
                    message = L10n("metaReview.batchNotAppliedStale")
                    messageIsError = true
                    return
                }
            } else if let coverDraft {
                _ = try await client.acceptDraft(
                    id: coverDraft.id,
                    version: coverDraft.version,
                    previewDigest: coverDraft.previewDigest,
                    idempotencyKey: operationKey
                )
            }
            let appliedCount = items.count
            let hadCover = coverDraft != nil
            await loadPage(
                albumID: page?.albumID,
                preferred: nextID
            )
            await loadAlbums()
            message = hadCover
                ? L10n("metaReview.appliedWithCover", appliedCount)
                : L10n("metaReview.applied", appliedCount)
            messageIsError = false
        } catch let error as APIError where error.statusCode == 409 {
            await reloadKeepingActive()
            message = L10n("metaReview.trackOrCandidateChanged")
            messageIsError = true
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    // MARK: - Labels

    private func fieldLabel(_ key: String) -> String {
        switch key {
        case "title": L10n("metaReview.fieldTitle")
        case "artists": L10n("metaReview.fieldArtists")
        case "album": L10n("metaReview.fieldAlbum")
        case "album_artists": L10n("metaReview.fieldAlbumArtists")
        case "vocalists": L10n("metaReview.fieldVocalists")
        case "lyricists": L10n("metaReview.fieldLyricists")
        case "composers": L10n("metaReview.fieldComposers")
        case "arrangers": L10n("metaReview.fieldArrangers")
        case "track_number": L10n("metaReview.fieldTrackNumber")
        case "disc_number": L10n("metaReview.fieldDiscNumber")
        case "track_total": L10n("metaReview.fieldTrackTotal")
        case "disc_total": L10n("metaReview.fieldDiscTotal")
        case "release_date": L10n("metaReview.fieldReleaseDate")
        case "original_date": L10n("metaReview.fieldOriginalDate")
        case "genres": L10n("metaReview.fieldGenres")
        case "external_ids": L10n("metaReview.fieldExternalIds")
        case "tags": L10n("metaReview.fieldTags")
        case "description": L10n("metaReview.fieldDescription")
        default: key
        }
    }

    private func candidateLabel(_ source: ReviewCandidate, track: ReviewTrack) -> String {
        var parts = [page?.providerNames[source.provider] ?? source.provider]
        if let title = source.fields["title"]?.display, !title.isEmpty, title != track.title {
            parts.append(title)
        }
        parts.append(source.fields["album"]?.display ?? L10n("metaReview.albumNotProvided"))
        if let date = source.fields["release_date"]?.display, !date.isEmpty {
            parts.append(date)
        }
        if let score = source.match?.score {
            parts.append(L10n("metaReview.matchScore", Int((score * 100).rounded())))
        }
        if source.metadataVersion != track.metadataVersion {
            parts.append(L10n("metaReview.expired"))
        }
        return parts.joined(separator: " · ")
    }
}

/// Server-frozen cover snapshot draft preview.
@MainActor
private struct ReviewCoverPreview: View {
    let client: WildstringClient
    let draftID: String
    let onReady: (Bool) -> Void

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                ProgressView()
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task(id: draftID) { await load() }
    }

    private func load() async {
        do {
            let data = try await client.draftCoverPreview(id: draftID)
            guard let loaded = UIImage(data: data) else {
                onReady(false)
                return
            }
            image = loaded
            onReady(true)
        } catch {
            onReady(false)
        }
    }
}
