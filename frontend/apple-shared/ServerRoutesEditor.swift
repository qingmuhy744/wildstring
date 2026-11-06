import CoreNetwork
import SwiftUI

@MainActor
struct ServerRoutesEditor: View {
    @Bindable var routes: ServerRoutes
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
                    VStack(alignment: .leading) {
                        HStack {
                            TextField("线路名称", text: Binding(get: { routes.profile.routes.first { $0.id == route.id }?.name ?? route.name }, set: { routes.rename(route, name: $0) }))
                            if route.address == routes.profile.activeAddress { Text("当前").font(.caption).foregroundStyle(.secondary) }
                            Button { routes.move(route, by: -1) } label: { Image(systemName: "arrow.up") }.disabled(index == 0).help("提高优先级")
                            Button { routes.move(route, by: 1) } label: { Image(systemName: "arrow.down") }.disabled(index == routes.profile.routes.count - 1).help("降低优先级")
                            Button("重新登录") { name = route.name; address = route.address; allowHTTP = route.allowHTTP }
                            Button(role: .destructive) { Task { await routes.remove(route) } } label: { Image(systemName: "trash") }.disabled(route.address == routes.profile.activeAddress).help("移除线路")
                        }
                        Text(route.address).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
            }
            Section("添加并独立登录") {
                TextField("线路名称，例如内网 / 公网", text: $name)
                TextField("服务器完整地址", text: $address).onChange(of: address) { _, _ in allowHTTP = false }
                Toggle("允许此线路使用 HTTP（请确认内网或 SD-WAN 保护）", isOn: $allowHTTP)
                TextField("账号", text: $username)
                SecureField("这条线路的登录密码", text: $password)
                Button(adding ? "验证中…" : "验证并添加线路") {
                    adding = true; error = nil
                    Task {
                        defer { adding = false; password = "" }
                        do { try await routes.add(name: name, address: address, allowHTTP: allowHTTP, username: username, password: password); name = ""; address = "" }
                        catch { self.error = (error as? APIError)?.code ?? "连接未完成，请检查地址、HTTP 许可和账号" }
                    }
                }.disabled(adding || password.isEmpty || address.isEmpty || name.isEmpty)
                Text("每条线路分别保存会话，不复制其他线路的 Cookie。线路设置仅保存在这台设备。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let message = error ?? routes.message { Text(message).foregroundStyle(.secondary) }
        }
        .disabled(routes.busy && !adding)
        .formStyle(.grouped)
    }
}
