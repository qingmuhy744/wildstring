import CoreNetwork
import SwiftUI

/// Per-account application policy shared by the assistant, inspections and MCP.
@MainActor
struct ApplicationPolicyView: View {
    let client: WildstringClient

    @State private var policy: ApplicationPolicy?
    @State private var mode = "manual"
    @State private var kinds: Set<String> = []
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var message: String?
    @State private var messageIsError = false

    private static let kindLabels: [(String, String)] = [
        ("playlist", "我的歌单"),
        ("metadata", "单曲信息"),
        ("metadata_batch", "专辑批量信息"),
        ("cover", "封面"),
        ("lyrics", "歌词"),
        ("intake", "导入整理"),
    ]

    var body: some View {
        Form {
            Section {
                Picker("整理方式", selection: $mode) {
                    Text("审核后应用").tag("manual")
                    Text("自动整理").tag("automatic")
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .disabled(isSaving || policy == nil)
                Text(
                    mode == "manual"
                        ? "查看草案后，点击接受即可直接应用。"
                        : "新草案中勾选的类型会直接应用，并保留修改记录。"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            } header: {
                Text("整理方式")
            } footer: {
                Text("按账号保存，助手、巡检和 MCP 共用；MCP 还需授予应用草案权限。")
            }

            if let policy {
                Section("自动应用范围") {
                    ForEach(policy.allowedKinds, id: \.self) { kind in
                        Toggle(
                            Self.kindLabels.first { $0.0 == kind }?.1 ?? kind,
                            isOn: Binding(
                                get: { kinds.contains(kind) },
                                set: { enabled in
                                    if enabled { kinds.insert(kind) } else { kinds.remove(kind) }
                                }
                            )
                        )
                        .disabled(isSaving || mode == "manual")
                    }
                }
                Section {
                    Button("保存整理方式") {
                        Task { await save() }
                    }
                    .disabled(
                        isSaving || policy == nil
                            || (mode == "automatic" && kinds.isEmpty)
                    )
                    if let message {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(messageIsError ? .red : .green)
                    }
                } footer: {
                    Text("已有待确认草案保持原状；资料保存在应用内，导入源不变。")
                }
            } else if isLoading {
                ProgressView()
            }
        }
        .navigationTitle("整理方式")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            apply(try await client.applicationPolicy())
            message = nil
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func save() async {
        guard let policy, !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            apply(
                try await client.saveApplicationPolicy(
                    mode: mode,
                    kinds: Array(kinds).sorted(),
                    version: policy.version
                )
            )
            message = "已保存整理方式。"
            messageIsError = false
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = "整理设置已在其他设备更新，已刷新，请重试。"
            messageIsError = true
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func apply(_ saved: ApplicationPolicy) {
        policy = saved
        mode = saved.mode
        kinds = Set(saved.kinds)
    }
}
