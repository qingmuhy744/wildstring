import CoreNetwork
import CorePlayback
import SwiftUI

struct MacDraftsView: View {
    let client: WildstringClient
    let playback: PlaybackService
    @State private var drafts: [Draft] = []
    @State private var filter = "pending"
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var selectedDraft: String?

    var body: some View {
        VStack(spacing: 0) {
            Picker(L10n("macDrafts.filterTitle"), selection: $filter) {
                Text(L10n("macDrafts.statusPending")).tag("pending")
                Text(L10n("macDrafts.statusApproved")).tag("approved")
                Text(L10n("macDrafts.statusApplied")).tag("applied")
                Text(L10n("macDrafts.statusRejected")).tag("rejected")
            }.pickerStyle(.segmented).padding(16)
            List(drafts) { draft in
                Button {
                    selectedDraft = draft.id
                } label: {
                    HStack(spacing: 14) {
                        Image(
                            systemName: draft.kind == "playlist" ? "music.note.list" : "doc.text.magnifyingglass"
                        )
                        .font(.title2).foregroundStyle(MacTheme.accentDeep)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(draft.title).font(.headline)
                            Text(macDraftStatus(draft)).font(.caption).foregroundStyle(.secondary)
                            if let evidence = draft.evidence.first {
                                Text(evidence.summary).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                        Spacer()
                        Text(L10n("macDrafts.viewDetails")).font(.callout).foregroundStyle(.secondary)
                        Image(systemName: "chevron.right").foregroundStyle(.secondary)
                    }.padding(.vertical, 10).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            .overlay {
                if loading {
                    ProgressView(L10n("macDrafts.loadingDrafts"))
                } else if drafts.isEmpty {
                    ContentUnavailableView(
                        errorMessage ?? L10n("macDrafts.emptyTitle"), systemImage: "checklist",
                        description: Text(L10n("macDrafts.emptyDesc")))
                }
            }
            if let errorMessage, !drafts.isEmpty {
                Text(errorMessage).font(.callout).foregroundStyle(.orange).padding()
            }
        }
        .navigationTitle(L10n("macDrafts.title"))
        .toolbar {
            Button {
                Task { await load() }
            } label: {
                Label(L10n("macDrafts.refresh"), systemImage: "arrow.clockwise")
            }.disabled(loading)
        }
        .task(id: filter) { await load() }
        .sheet(
            isPresented: Binding(
                get: { selectedDraft != nil }, set: { if !$0 { selectedDraft = nil } }
            ), onDismiss: { Task { await load() } }
        ) {
            if let selectedDraft {
                MacDraftPreview(client: client, playback: playback, draftID: selectedDraft)
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let value = try await MacPages.collect { offset in
                try await client.drafts(limit: 100, offset: offset, status: filter)
            }
            guard !Task.isCancelled else { return }
            drafts = value
            errorMessage = nil
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = MacErrorText.message(for: error)
        }
    }
}

struct MacDraftPreview: View {
    let client: WildstringClient
    let playback: PlaybackService
    let draftID: String
    @Environment(\.dismiss) private var dismiss
    @State private var draft: Draft?
    @State private var tracks: [Track] = []
    @State private var loading = true
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var idempotencyKey = "macos-" + UUID().uuidString.lowercased()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(draft?.title ?? L10n("macDrafts.draftDetails")).font(.title2.bold()).lineLimit(2)
                    if let draft { Text(macDraftStatus(draft)).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                Button(L10n("macDrafts.close")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
            }.padding(24)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let draft {
                        if draft.kind == "playlist" {
                            Text(draft.payload?.name ?? draft.title).font(.headline)
                            Text(L10n("macDrafts.tracksPreviewCount", draft.payload?.trackIds?.count ?? 0))
                                .font(.callout).foregroundStyle(.secondary)
                            if draft.payload?.playlistID != nil, !draft.isApplied {
                                Label(L10n("macDrafts.replacePlaylistWarning"), systemImage: "arrow.triangle.2.circlepath")
                                    .font(.callout).foregroundStyle(.orange)
                            }
                            MacAssistantTracks(client: client, playback: playback, tracks: tracks)
                        } else {
                            Label(L10n("macDrafts.webDiffNotice"), systemImage: "doc.text.magnifyingglass")
                                .font(.callout)
                            Link(L10n("macDrafts.openWebVersion"), destination: client.server.url)
                        }
                        if !draft.evidence.isEmpty {
                            Divider()
                            Text(L10n("macDrafts.evidence")).font(.headline)
                            ForEach(Array(draft.evidence.enumerated()), id: \.offset) { _, evidence in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(evidence.summary).textSelection(.enabled)
                                    if let raw = evidence.url, let url = URL(string: raw), url.scheme == "https" {
                                        Link(evidence.source, destination: url).font(.caption)
                                    } else {
                                        Text(evidence.source).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    if loading { ProgressView(L10n("macDrafts.loadingPreview")).frame(maxWidth: .infinity) }
                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.circle").foregroundStyle(.orange)
                    }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack(spacing: 12) {
                Button(L10n("macDrafts.refreshPreview")) { Task { await load() } }.disabled(loading || busy)
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                if let draft, draft.kind == "playlist", draft.isPending || draft.isApproved {
                    Button(L10n("macDrafts.reject"), role: .destructive) { Task { await reject(draft) } }.disabled(
                        loading || busy)
                    Button(draft.payload?.playlistID == nil ? L10n("macDrafts.saveAsPlaylist") : L10n("macDrafts.updatePlaylist")) {
                        Task { await save(draft) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(loading || busy || errorMessage != nil)
                } else if draft?.isApplied == true {
                    Label(draft?.kind == "playlist" ? L10n("macDrafts.playlistSaved") : L10n("macDrafts.statusApplied"), systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }.padding(20)
        }
        .frame(width: 660, height: 640)
        .interactiveDismissDisabled(busy)
        .task { await load() }
    }

    private func load() async {
        loading = true
        errorMessage = nil
        tracks = []
        defer { loading = false }
        do {
            let value = try await client.draft(id: draftID)
            if draft?.version != value.version {
                idempotencyKey = "macos-" + UUID().uuidString.lowercased()
            }
            draft = value
            if value.kind == "playlist" {
                // Keep the proposed order, and never silently omit a missing song.
                // Bounded batches avoid launching thousands of cover/track requests at once.
                let ids = value.payload?.trackIds ?? []
                for start in stride(from: 0, to: ids.count, by: 8) {
                    let batch = Array(ids[start..<min(start + 8, ids.count)])
                    let loaded = try await withThrowingTaskGroup(of: (Int, Track).self) { group in
                        for (index, id) in batch.enumerated() {
                            group.addTask { (index, try await client.track(id: id)) }
                        }
                        var values: [(Int, Track)] = []
                        for try await value in group { values.append(value) }
                        return values.sorted { $0.0 < $1.0 }.map(\.1)
                    }
                    tracks += loaded
                }
            }
        } catch {
            errorMessage = L10n("macDrafts.previewIncomplete", MacErrorText.message(for: error))
        }
    }

    private func save(_ value: Draft) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            draft = try await client.acceptDraft(
                id: value.id, version: value.version, previewDigest: value.previewDigest,
                idempotencyKey: idempotencyKey
            )
            errorMessage = draft?.isApplied == true ? nil : L10n("macDrafts.serverNotConfirmed")
        } catch {
            errorMessage = L10n("macDrafts.saveErrorRefreshHint", MacErrorText.message(for: error))
        }
    }

    private func reject(_ value: Draft) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            draft = try await client.rejectDraft(id: value.id, version: value.version)
            errorMessage = nil
        } catch {
            errorMessage = MacErrorText.message(for: error)
        }
    }
}

private func macDraftStatus(_ draft: Draft) -> String {
    switch draft.status {
    case "pending": return L10n("macDrafts.statusPendingDetail")
    case "approved": return L10n("macDrafts.statusApprovedDetail")
    case "applied": return draft.kind == "playlist" ? L10n("macDrafts.statusAppliedPlaylist") : L10n("macDrafts.statusApplied")
    case "rejected": return L10n("macDrafts.statusRejected")
    default: return draft.status
    }
}
