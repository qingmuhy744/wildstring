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

    var body: some View {
        NavigationStack {
            List {
                if drafts.isEmpty, !isLoading {
                    ContentUnavailableView(
                        "没有草案",
                        systemImage: "checklist",
                        description: Text("让助手帮你做点什么，草案会出现在这里。")
                    )
                }
                ForEach(drafts) { draft in
                    DraftRow(
                        draft: draft,
                        busy: busyID == draft.id,
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
            .navigationTitle("助手草案")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
            }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            drafts = try await client.drafts().items
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
            message = "已生成歌单"
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
                Text("\(trackIds.count) 首曲目")
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
                    Button("批准", action: onApprove)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    Button("拒绝", role: .destructive, action: onReject)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                } else if draft.isApproved {
                    Button("应用", action: onApply)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    private var kindLabel: String {
        draft.kind == "playlist" ? "歌单" : "元数据"
    }

    private var statusText: String {
        switch draft.status {
        case "pending": return "待批准"
        case "approved": return "已批准，等待应用"
        case "applied":
            if draft.result?.playlistId != nil { return "已应用 · 已生成歌单" }
            return "已应用"
        case "rejected": return "已拒绝"
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
