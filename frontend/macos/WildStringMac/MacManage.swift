import CoreNetwork
import SwiftUI

struct MacManageView: View {
    let client: WildstringClient

    @State private var scans: [ScanRecord] = []
    @State private var imports: [ImportRecord] = []
    @State private var message: String?
    @State private var loading = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("曲库运行记录").font(.title2.bold())
                        Text("查看最近的导入和扫描；曲库配置与批量管理在网页版中完成。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Link(destination: client.server.url) {
                        Label("打开网页版", systemImage: "arrow.up.right.square")
                    }.buttonStyle(.bordered)
                }
                if let message {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange)
                }
                if loading, imports.isEmpty, scans.isEmpty {
                    ProgressView("正在读取记录…").frame(maxWidth: .infinity).padding(24)
                } else {
                    recordSection("导入记录", count: imports.count) {
                        ForEach(imports) { record in
                            MacTaskRecordCard(status: record.status ?? "unknown", startedAt: record.startedAt,
                                summary: importSummary(record.counts ?? [:]), errors: record.errors ?? [])
                        }
                    }
                    recordSection("扫描记录", count: scans.count) {
                        ForEach(scans) { record in
                            MacTaskRecordCard(status: record.status, startedAt: record.startedAt,
                                summary: record.counts.map(scanSummary) ?? "暂无统计", errors: record.errors ?? [])
                        }
                    }
                }
            }
            .padding(28)
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .navigationTitle("管理")
        .toolbar {
            Button { Task { await load() } } label: {
                Label("刷新记录", systemImage: "arrow.clockwise")
            }.disabled(loading)
        }
        .task { await load() }
    }

    private func recordSection<Content: View>(_ title: String, count: Int, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title).font(.headline)
                Text("最近 \(count) 项").font(.caption).foregroundStyle(.secondary)
            }
            if count == 0 {
                Text(message == nil ? "还没有记录" : "记录暂时不可用")
                    .font(.callout).foregroundStyle(.secondary).padding(.vertical, 12)
            }
            content()
        }
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            async let newImports = client.imports(limit: 20)
            async let newScans = client.scans(limit: 20)
            (imports, scans) = try await (newImports, newScans)
            message = nil
        } catch {
            message = MacErrorText.message(for: error)
        }
    }

    private func scanSummary(_ counts: ScanCounts) -> String {
        var parts: [String] = []
        if let visited = counts.visited { parts.append("检查 \(visited)") }
        if let added = counts.added, added > 0 { parts.append("新增 \(added)") }
        if let updated = counts.updated, updated > 0 { parts.append("更新 \(updated)") }
        if let unchanged = counts.unchanged, unchanged > 0 { parts.append("未变 \(unchanged)") }
        if let missing = counts.missing, missing > 0 { parts.append("缺失 \(missing)") }
        if let skipped = counts.skipped, skipped > 0 { parts.append("跳过 \(skipped)") }
        if let errors = counts.errors, errors > 0 { parts.append("错误 \(errors)") }
        return parts.isEmpty ? "没有曲目变更" : parts.joined(separator: " · ")
    }

    private func importSummary(_ counts: [String: Int]) -> String {
        let labels = [("copied", "导入"), ("converted", "转换"), ("unchanged", "未变"),
            ("duplicates", "重复"), ("assets_copied", "附件"), ("review", "待整理"),
            ("waiting", "等待"), ("skipped", "跳过"), ("conflicts", "冲突"), ("errors", "错误")]
        let parts = labels.compactMap { key, label -> String? in
            guard let value = counts[key], value > 0 else { return nil }
            return "\(label) \(value)"
        }
        return parts.isEmpty ? "没有文件变更" : parts.joined(separator: " · ")
    }
}

private struct MacTaskRecordCard: View {
    let status: String
    let startedAt: String?
    let summary: String
    let errors: [ScanErrorDetail]

    private var statusText: String {
        let labels = ["completed": "已完成", "completed_with_errors": "完成，部分失败", "failed": "失败",
            "running": "进行中", "queued": "等待处理", "interrupted": "已中断", "cancelled": "已取消"]
        return labels[status] ?? status
    }

    private var statusColor: Color {
        if status == "completed" { return .secondary }
        if status == "running" || status == "queued" { return MacTheme.accentDeep }
        return .orange
    }

    private var dateText: String {
        guard let startedAt else { return "时间未提供" }
        let formatter = ISO8601DateFormatter()
        var date = formatter.date(from: startedAt)
        if date == nil {
            formatter.formatOptions.insert(.withFractionalSeconds)
            date = formatter.date(from: startedAt)
        }
        return date?.formatted(date: .abbreviated, time: .shortened) ?? startedAt
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(statusText).font(.callout.weight(.semibold)).foregroundStyle(statusColor)
                Spacer()
                Text(dateText).font(.caption).foregroundStyle(.secondary)
            }
            Text(summary).font(.callout).foregroundStyle(.secondary)
            if !errors.isEmpty {
                DisclosureGroup("查看 \(errors.count) 项错误") {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(errors.enumerated()), id: \.offset) { _, error in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(error.message ?? error.code ?? "处理失败")
                                if let path = error.path { Text(path).foregroundStyle(.secondary) }
                            }.font(.caption).textSelection(.enabled)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                }.font(.caption)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct MacMetadataSheet: View {
    let client: WildstringClient
    let track: Track

    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var artists = ""
    @State private var album = ""
    @State private var version = 0
    @State private var ready = false
    @State private var saving = false
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("歌曲信息")
                .font(.title3.bold())
            Text("修改保存到曲库资料中，不会改写音频文件。")
                .font(.callout)
                .foregroundStyle(.secondary)
            TextField("标题", text: $title)
                .textFieldStyle(.roundedBorder)
            TextField("艺人，用 / 分开", text: $artists)
                .textFieldStyle(.roundedBorder)
            TextField("专辑", text: $album)
                .textFieldStyle(.roundedBorder)
            if let message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                Button("取消", role: .cancel) { dismiss() }
                Button(saving ? "正在保存…" : "保存") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!ready || saving || title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 440)
        .task { await load() }
    }

    private func load() async {
        do {
            let metadata = try await client.manageMetadata(trackID: track.id)
            let fields = metadata.effective
            title = fields.title ?? track.title
            artists = (fields.artists ?? track.artists).joined(separator: " / ")
            album = fields.album ?? track.album ?? ""
            version = metadata.version
            ready = true
            message = nil
        } catch {
            message = MacErrorText.message(for: error)
        }
    }

    private func save() async {
        guard ready, !saving else { return }
        saving = true
        defer { saving = false }
        var overrides = MetadataOverrides()
        overrides.title = title.trimmingCharacters(in: .whitespaces)
        overrides.artists = artists
            .split(separator: "/")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        overrides.album = album.trimmingCharacters(in: .whitespaces)
        do {
            _ = try await client.updateMetadata(trackID: track.id, version: version, overrides: overrides)
            dismiss()
        } catch {
            message = MacErrorText.message(for: error)
        }
    }
}
