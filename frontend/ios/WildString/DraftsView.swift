import CoreNetwork
import SwiftUI

@MainActor
struct DraftsView: View {
    let client: WildstringClient

    @Environment(\.dismiss) private var dismiss
    @State private var drafts: [Draft] = []
    @State private var isLoading = true
    @State private var busyID: String?
    @State private var message: String?
    @State private var filter: DraftFilter = .pending

    private enum DraftFilter: Hashable, CaseIterable {
        case pending
        case processed
        case all

        var label: String {
            switch self {
            case .pending: L10n("drafts.filterPending")
            case .processed: L10n("drafts.filterProcessed")
            case .all: L10n("drafts.filterAll")
            }
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if drafts.isEmpty, !isLoading {
                    ContentUnavailableView(
                        L10n("drafts.emptyTitle"),
                        systemImage: "checklist",
                        description: Text(L10n("drafts.emptyDescription"))
                    )
                }
                ForEach(drafts) { draft in
                    DraftRow(
                        draft: draft,
                        busy: busyID == draft.id,
                        onAccept: { Task { await accept(draft) } },
                        onApprove: { Task { await approve(draft) } },
                        onReject: { Task { await reject(draft) } },
                        onApply: { Task { await apply(draft) } }
                    )
                }
                if let message {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .listStyle(.plain)
            .safeAreaInset(edge: .top) {
                Picker(L10n("drafts.statusPicker"), selection: $filter) {
                    ForEach(DraftFilter.allCases, id: \.self) { value in
                        Text(value.label).tag(value)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .background(.bar)
            }
            .navigationTitle(L10n("drafts.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(L10n("drafts.close")) { dismiss() }
                }
            }
            .task { await load() }
            .onChange(of: filter) { _, _ in
                Task { await load() }
            }
            .refreshable { await load() }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await client.drafts(
                limit: 100,
                status: filter == .pending ? "pending" : nil
            )
            drafts = filter == .processed
                ? page.items.filter { !$0.isPending }
                : page.items
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func accept(_ draft: Draft) async {
        busyID = draft.id
        defer { busyID = nil }
        do {
            replace(
                try await client.acceptDraft(
                    id: draft.id,
                    version: draft.version,
                    previewDigest: draft.previewDigest
                )
            )
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func approve(_ draft: Draft) async {
        busyID = draft.id
        defer { busyID = nil }
        do {
            replace(try await client.approveDraft(id: draft.id, version: draft.version))
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func reject(_ draft: Draft) async {
        busyID = draft.id
        defer { busyID = nil }
        do {
            replace(try await client.rejectDraft(id: draft.id, version: draft.version))
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func apply(_ draft: Draft) async {
        busyID = draft.id
        defer { busyID = nil }
        do {
            let applied = try await client.applyDraft(id: draft.id, version: draft.version)
            replace(applied)
            message = L10n("drafts.playlistGenerated")
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func replace(_ draft: Draft) {
        if let index = drafts.firstIndex(where: { $0.id == draft.id }) {
            drafts[index] = draft
        } else {
            drafts.append(draft)
        }
    }
}

private struct DraftRow: View {
    let draft: Draft
    let busy: Bool
    let onAccept: () -> Void
    let onApprove: () -> Void
    let onReject: () -> Void
    let onApply: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(draft.title)
                    .font(.headline)
                    .lineLimit(2)
                Spacer()
                Text(kindLabel)
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color(.secondarySystemBackground), in: Capsule())
            }
            Text(statusText)
                .font(.caption)
                .foregroundStyle(statusColor)
            if let payload = draft.payload, let trackIds = payload.trackIds, !trackIds.isEmpty {
                Text(L10n("drafts.trackCount", trackIds.count))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(draft.evidence.prefix(2).enumerated()), id: \.offset) { _, evidence in
                Text("· \(evidence.summary)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            HStack(spacing: 10) {
                if busy {
                    ProgressView()
                } else if draft.isPending {
                    Button(L10n("drafts.acceptAndApply"), action: onAccept)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    Button(L10n("drafts.approve"), action: onApprove)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    Button(L10n("drafts.reject"), role: .destructive, action: onReject)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                } else if draft.isApproved {
                    Button(L10n("drafts.apply"), action: onApply)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    private var kindLabel: String {
        switch draft.kind {
        case "playlist": return L10n("drafts.kindPlaylist")
        case "metadata_batch": return L10n("drafts.kindMetadataBatch")
        case "cover": return L10n("drafts.kindCover")
        case "lyrics": return L10n("drafts.kindLyrics")
        case "intake": return L10n("drafts.kindIntake")
        default: return L10n("drafts.kindMetadata")
        }
    }

    private var statusText: String {
        switch draft.status {
        case "pending": return L10n("drafts.statusPending")
        case "approved": return L10n("drafts.statusApproved")
        case "applied":
            if draft.result?.playlistId != nil { return L10n("drafts.statusAppliedPlaylist") }
            return L10n("drafts.statusApplied")
        case "rejected": return L10n("drafts.statusRejected")
        default: return draft.status
        }
    }

    private var statusColor: Color {
        switch draft.status {
        case "pending": return .orange
        case "approved": return .blue
        case "applied": return .green
        default: return .secondary
        }
    }
}
