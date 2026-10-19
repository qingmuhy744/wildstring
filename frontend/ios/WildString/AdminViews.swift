import CoreNetwork
import SwiftUI

@MainActor
struct ScansView: View {
    let client: WildstringClient

    @State private var scans: [ScanRecord] = []
    @State private var isLoading = true
    @State private var message: String?

    var body: some View {
        List {
            ForEach(scans) { scan in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(String(scan.id.prefix(8)) + "…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(statusText(scan.status))
                            .font(.caption.bold())
                            .foregroundStyle(statusColor(scan.status))
                    }
                    if let counts = scan.counts {
                        Text(countsText(counts))
                            .font(.caption)
                    }
                    if let started = scan.startedAt {
                        Text(started)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if let errors = scan.errors, !errors.isEmpty {
                        Text("\(errors.count) 条错误")
                            .font(.caption)
                            .foregroundStyle(.red)
                        ForEach(Array(errors.prefix(3).enumerated()), id: \.offset) { _, error in
                            Text("· \(error.path ?? error.code ?? error.message ?? "错误")")
                                .font(.caption2)
                                .foregroundStyle(.red)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            if isLoading {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            } else if scans.isEmpty {
                Text("没有扫描记录")
                    .foregroundStyle(.secondary)
            }
            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .listStyle(.plain)
        .navigationTitle("扫描任务")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            scans = try await client.scans()
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func countsText(_ counts: ScanCounts) -> String {
        var parts: [String] = []
        if let value = counts.visited { parts.append("访问 \(value)") }
        if let value = counts.added { parts.append("新增 \(value)") }
        if let value = counts.updated { parts.append("更新 \(value)") }
        if let value = counts.missing { parts.append("缺失 \(value)") }
        if let value = counts.skipped { parts.append("跳过 \(value)") }
        if let value = counts.errors, value > 0 { parts.append("错误 \(value)") }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }

    private func statusText(_ status: String) -> String {
        switch status {
        case "running": return "进行中"
        case "completed": return "完成"
        case "completed_with_errors": return "完成（有错误）"
        case "failed": return "失败"
        case "interrupted": return "中断"
        default: return status
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "completed": return .green
        case "running": return .blue
        case "completed_with_errors": return .orange
        default: return .red
        }
    }
}

@MainActor
struct ImportsView: View {
    let client: WildstringClient

    @State private var imports: [ImportRecord] = []
    @State private var isLoading = true
    @State private var message: String?

    var body: some View {
        List {
            ForEach(imports) { record in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(String(record.id.prefix(8)) + "…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        if let status = record.status {
                            Text(status)
                                .font(.caption.bold())
                                .foregroundStyle(status == "completed" ? .green : .orange)
                        }
                    }
                    if let counts = record.counts, !counts.isEmpty {
                        Text(
                            counts.sorted { $0.key < $1.key }
                                .map { "\($0.key) \($0.value)" }
                                .joined(separator: " · ")
                        )
                        .font(.caption)
                    }
                    if let started = record.startedAt {
                        Text(started)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if let errors = record.errors, !errors.isEmpty {
                        Text("\(errors.count) 条错误")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                .padding(.vertical, 2)
            }
            if isLoading {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            } else if imports.isEmpty {
                Text("没有导入记录")
                    .foregroundStyle(.secondary)
            }
            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .listStyle(.plain)
        .navigationTitle("导入记录")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            imports = try await client.imports()
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }
}
