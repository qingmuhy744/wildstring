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

    private enum DraftFilter: String, CaseIterable {
        case pending = "待处理"
        case processed = "已处理"
        case all = "全部"
    }

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
                Picker("状态", selection: $filter) {
                    ForEach(DraftFilter.allCases, id: \.self) { value in
                        Text(value.rawValue).tag(value)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .background(.bar)
            }
            .navigationTitle("助手草案")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
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
                    Button("接受并应用", action: onAccept)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    Button("批准", action: onApprove)
                        .buttonStyle(.bordered)
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
        switch draft.kind {
        case "playlist": return "歌单"
        case "metadata_batch": return "专辑批量"
        case "cover": return "封面"
        case "lyrics": return "歌词"
        case "intake": return "导入"
        default: return "元数据"
        }
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
