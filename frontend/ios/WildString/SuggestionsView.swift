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
                    Toggle("只补缺失信息", isOn: $missingOnly)
                    Toggle("重新联网查询", isOn: $forceLookup)
                    Button("更新元数据") { Task { await refresh() } }
                        .disabled(isWorking)
                } header: {
                    Text(track.title)
                } footer: {
                    Text("联网结果只作为建议保存；勾选后确认才会写入数据库，导入源与音频文件不变。")
                }

                if let jobs = results?.jobs, !jobs.isEmpty {
                    Section("查询任务") {
                        ForEach(jobs.prefix(3)) { job in
                            HStack {
                                Text("任务")
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
                        Text("暂无候选。联网查询完成后，各来源的建议会显示在这里。")
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
            .navigationTitle("更新元数据与建议")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
            }
            .task { await poll() }
            .alert(
                "应用选中信息？",
                isPresented: Binding(
                    get: { pendingApply != nil },
                    set: { if !$0 { pendingApply = nil } }
                ),
                presenting: pendingApply
            ) { pending in
                Button("确认应用") { Task { await apply(pending) } }
                Button("取消", role: .cancel) {}
            } message: { pending in
                Text("将覆盖这 \(pending.fields.count) 个字段的当前值。")
            }
            .alert(
                "采用此封面？",
                isPresented: Binding(
                    get: { pendingCover != nil },
                    set: { if !$0 { pendingCover = nil } }
                ),
                presenting: pendingCover
            ) { suggestion in
                Button("确认采用") { Task { await applyCover(suggestion) } }
                Button("取消", role: .cancel) {}
            } message: { _ in
                Text("封面会保存到服务端曲库，导入源与音频文件不变。")
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
                Text("歌曲信息已变化，请重新查询。")
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
                Button("采用此封面") { pendingCover = suggestion }
                    .disabled(isWorking)
            }
            Button("应用选中信息") {
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
                    Text("匹配 \(Int((score * 100).rounded()))%")
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
        case "title": return "歌曲名称"
        case "artists": return "歌曲艺人"
        case "album": return "专辑"
        case "album_artists": return "专辑艺人"
        case "vocalists": return "演唱"
        case "lyricists": return "作词"
        case "composers": return "作曲"
        case "arrangers": return "编曲"
        case "track_number": return "曲号"
        case "disc_number": return "碟号"
        case "release_date": return "发行日期"
        case "tags": return "标签"
        case "description": return "简介"
        default: return key
        }
    }

    private func providerName(_ id: String) -> String {
        let name = results?.providerNames[id] ?? ""
        return name.isEmpty ? id : name
    }

    private func statusText(_ status: String?) -> String {
        switch status {
        case "queued": return "等待中"
        case "running": return "执行中"
        case "completed": return "已完成"
        case "completed_with_errors": return "完成，部分来源失败"
        case "stale": return "来源已过期"
        case "failed": return "失败"
        case "interrupted": return "已中断"
        case "review": return "待确认"
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
            message = "已排队 \(queued.queued) 首，建议准备好后显示在这里"
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
            message = "建议已应用"
            messageIsError = false
            await load()
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = "歌曲信息已变化，已刷新，请重新查询"
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
            message = "封面已保存"
            messageIsError = false
            await load()
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = "歌曲信息已变化，已刷新，请重新查询"
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
                Text("封面预览不可用")
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
