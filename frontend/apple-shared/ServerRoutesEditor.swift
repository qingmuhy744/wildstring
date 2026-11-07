import CoreNetwork
import SwiftUI

@MainActor
struct ServerRoutesEditor: View {
    @Bindable var routes: ServerRoutes

    enum FormMode: Equatable {
        case add
        case reauth(ServerRoute)

        var title: String {
            switch self {
            case .add: return "添加新线路并独立登录"
            case .reauth(let route): return "重新登录线路「\(route.name)」"
            }
        }

        var submitTitle: String {
            switch self {
            case .add: return "验证并添加线路"
            case .reauth: return "重新验证并更新"
            }
        }
    }

    @State private var formMode: FormMode?
    @State private var name = ""
    @State private var address = ""
    @State private var username = ""
    @State private var password = ""
    @State private var allowHTTP = false
    @State private var error: String?
    @State private var adding = false

    var body: some View {
        Form {
            Section("线路模式") {
                Picker("选择", selection: Binding(get: { routes.profile.manualAddress ?? "" }, set: { value in Task { await routes.select(value.isEmpty ? nil : value) } })) {
                    Text("Fallback · 故障时按优先级切换").tag("")
                    ForEach(routes.profile.routes) { route in Text("手动 · \(route.name)").tag(route.address) }
                }
                Text("Fallback 保持当前可用线路；手动模式固定线路。重新选择 Fallback 会从第一条线路开始尝试。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("线路优先级") {
                ForEach(Array(routes.profile.routes.enumerated()), id: \.element.id) { index, route in
                    ServerRouteRow(
                        route: route,
                        index: index,
                        totalCount: routes.profile.routes.count,
                        isActive: route.address == routes.profile.activeAddress,
                        onRename: { newName in routes.rename(route, name: newName) },
                        onMove: { distance in routes.move(route, by: distance) },
                        onReauth: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                name = route.name
                                address = route.address
                                allowHTTP = route.allowHTTP
                                password = ""
                                error = nil
                                formMode = .reauth(route)
                            }
                        },
                        onRemove: {
                            Task { await routes.remove(route) }
                        }
                    )
                }

                if formMode == nil {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            name = ""
                            address = ""
                            allowHTTP = false
                            password = ""
                            error = nil
                            formMode = .add
                        }
                    } label: {
                        Label("添加新线路…", systemImage: "plus")
                    }
                    .buttonStyle(.borderless)
                }
            }

            if let mode = formMode {
                Section(mode.title) {
                    TextField("线路名称，例如内网 / 备用公网", text: $name)
                    TextField("服务器完整地址", text: $address).onChange(of: address) { _, _ in allowHTTP = false }
                    Toggle("允许此线路使用 HTTP（请确认内网或 SD-WAN 保护）", isOn: $allowHTTP)
                    TextField("账号", text: $username)
                    SecureField("登录密码", text: $password)
                    HStack(spacing: 12) {
                        Button("取消") {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                formMode = nil
                                error = nil
                                password = ""
                            }
                        }
                        .buttonStyle(.bordered)

                        Button(adding ? "验证中…" : mode.submitTitle) {
                            adding = true; error = nil
                            Task {
                                defer { adding = false; password = "" }
                                do {
                                    try await routes.add(name: name, address: address, allowHTTP: allowHTTP, username: username, password: password)
                                    name = ""
                                    address = ""
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        formMode = nil
                                    }
                                } catch {
                                    self.error = (error as? APIError)?.code ?? "连接未完成，请检查地址、HTTP 许可和账号"
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(adding || password.isEmpty || address.isEmpty || name.isEmpty || username.isEmpty)
                    }
                    Text("每条线路分别保存会话，不复制其他线路的 Cookie。线路设置仅保存在这台设备。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let message = error ?? routes.message {
                Text(message)
                    .foregroundStyle(error != nil ? .red : .secondary)
                    .font(.caption)
            }
        }
        .disabled(routes.busy && !adding)
        .formStyle(.grouped)
    }
}

private struct ServerRouteRow: View {
    let route: ServerRoute
    let index: Int
    let totalCount: Int
    let isActive: Bool
    let onRename: (String) -> Void
    let onMove: (Int) -> Void
    let onReauth: () -> Void
    let onRemove: () -> Void

    @State private var isEditing = false
    @State private var draftName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if isEditing {
                    TextField("线路名称", text: $draftName)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { commitRename() }
                    Button("保存") { commitRename() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("取消") { cancelRename() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                } else {
                    Text(route.name)
                        .font(.body)
                        .fontWeight(.medium)
                        .lineLimit(1)
                    Button {
                        draftName = route.name
                        isEditing = true
                    } label: {
                        Image(systemName: "pencil")
                    }
                    .buttonStyle(.borderless)
                    .help("修改线路名称")

                    if isActive {
                        Text("当前")
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.15))
                            .foregroundStyle(Color.accentColor)
                            .clipShape(Capsule())
                    }

                    Spacer()

                    Button { onMove(-1) } label: { Image(systemName: "arrow.up") }
                        .buttonStyle(.borderless)
                        .disabled(index == 0)
                        .help("提高优先级")
                    Button { onMove(1) } label: { Image(systemName: "arrow.down") }
                        .buttonStyle(.borderless)
                        .disabled(index == totalCount - 1)
                        .help("降低优先级")
                    Button("重新登录") { onReauth() }
                        .buttonStyle(.borderless)
                    Button(role: .destructive) { onRemove() } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless)
                        .disabled(isActive || totalCount <= 1)
                        .help("移除线路")
                }
            }
            Text(route.address)
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .padding(.vertical, 2)
    }

    private func commitRename() {
        let trimmed = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            onRename(trimmed)
        }
        isEditing = false
    }

    private func cancelRename() {
        draftName = route.name
        isEditing = false
    }
}
