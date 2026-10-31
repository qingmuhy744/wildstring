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
            Picker("草案状态", selection: $filter) {
                Text("待确认").tag("pending")
                Text("已批准待应用").tag("approved")
                Text("已应用").tag("applied")
                Text("已拒绝").tag("rejected")
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
                        Text("查看详情").font(.callout).foregroundStyle(.secondary)
                        Image(systemName: "chevron.right").foregroundStyle(.secondary)
                    }.padding(.vertical, 10).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            .overlay {
                if loading {
                    ProgressView("正在加载草案…")
                } else if drafts.isEmpty {
                    ContentUnavailableView(
                        errorMessage ?? "这里还没有草案", systemImage: "checklist",
                        description: Text("助手生成的建议会保存在这里，查看内容后再决定是否采用。"))
                }
            }
            if let errorMessage, !drafts.isEmpty {
                Text(errorMessage).font(.callout).foregroundStyle(.orange).padding()
            }
        }
        .navigationTitle("助手草案")
        .toolbar {
            Button {
                Task { await load() }
            } label: {
                Label("刷新", systemImage: "arrow.clockwise")
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
                    Text(draft?.title ?? "草案详情").font(.title2.bold()).lineLimit(2)
                    if let draft { Text(macDraftStatus(draft)).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
            }.padding(24)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let draft {
                        if draft.kind == "playlist" {
                            Text(draft.payload?.name ?? draft.title).font(.headline)
                            Text("\(draft.payload?.trackIds?.count ?? 0) 首歌曲 · 点击歌曲可试听")
                                .font(.callout).foregroundStyle(.secondary)
                            if draft.payload?.playlistID != nil, !draft.isApplied {
                                Label("保存后会替换原歌单的名称与曲目顺序。", systemImage: "arrow.triangle.2.circlepath")
                                    .font(.callout).foregroundStyle(.orange)
                            }
                            MacAssistantTracks(client: client, playback: playback, tracks: tracks)
                        } else {
                            Label("这份草案需要对照资料差异，请在网页版查看完整预览后处理。", systemImage: "doc.text.magnifyingglass")
                                .font(.callout)
                            Link("打开网页版查看", destination: client.server.url)
                        }
                        if !draft.evidence.isEmpty {
                            Divider()
                            Text("生成依据").font(.headline)
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
                    if loading { ProgressView("正在加载预览…").frame(maxWidth: .infinity) }
                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.circle").foregroundStyle(.orange)
                    }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack(spacing: 12) {
                Button("刷新预览") { Task { await load() } }.disabled(loading || busy)
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                if let draft, draft.kind == "playlist", draft.isPending || draft.isApproved {
                    Button("拒绝", role: .destructive) { Task { await reject(draft) } }.disabled(
                        loading || busy)
                    Button(draft.payload?.playlistID == nil ? "保存为歌单" : "更新歌单") {
                        Task { await save(draft) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(loading || busy || errorMessage != nil)
                } else if draft?.isApplied == true {
                    Label(draft?.kind == "playlist" ? "歌单已保存" : "已应用", systemImage: "checkmark.circle.fill")
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
            errorMessage = "预览未完整加载：\(MacErrorText.message(for: error))"
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
            errorMessage = draft?.isApplied == true ? nil : "服务器尚未确认保存，请刷新查看最新状态。"
        } catch {
            errorMessage = "\(MacErrorText.message(for: error))。请刷新预览确认保存状态。"
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
    case "pending": return "待确认 · 尚未保存"
    case "approved": return "已批准 · 尚未应用"
    case "applied": return draft.kind == "playlist" ? "已应用 · 歌单已保存" : "已应用"
    case "rejected": return "已拒绝"
    default: return draft.status
    }
}
