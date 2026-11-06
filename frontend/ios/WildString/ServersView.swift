import SwiftUI

/// Saved servers: tap to switch, swipe to delete (clears that server's
/// session, caches, offline copies and queue space).
@MainActor
struct ServersView: View {
    @Bindable var model: ConnectionModel

    @State private var editing: SavedServer?
    @State private var alias = ""
    @State private var showRoutes = false

    var body: some View {
        NavigationStack {
            List {
                if !model.servers.isEmpty {
                    Section("已保存的服务器") {
                        ForEach(model.servers) { server in
                            Button {
                                Task { await model.connect(to: server) }
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(server.label)
                                        .lineLimit(1)
                                    Text(server.username)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("本机别名") { alias = server.alias ?? ""; editing = server }
                            }
                            .swipeActions {
                                Button("删除", role: .destructive) {
                                    Task { await model.deleteServer(server) }
                                }
                            }
                        }
                    }
                }
                if model.routes != nil {
                    Section { Button("当前服务器线路") { showRoutes = true } }
                }
                Section {
                    Button {
                        model.showAddServer()
                    } label: {
                        Label("添加服务器", systemImage: "plus")
                    }
                } footer: {
                    Text("每个服务器保存独立的登录、缓存、离线与队列。")
                }
                if let message = model.errorMessage {
                    Section {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("野弦")
            .sheet(isPresented: $showRoutes) {
                if let routes = model.routes {
                    NavigationStack { ServerRoutesEditor(routes: routes).navigationTitle("服务器线路").toolbar { Button("完成") { showRoutes = false } } }
                }
            }
            .alert("本机别名", isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
                TextField("留空使用服务器名称", text: $alias)
                Button("保存") { if let editing { model.setAlias(alias, for: editing) }; editing = nil }
                Button("取消", role: .cancel) { editing = nil }
            } message: { Text("别名仅保存在这台设备。") }
        }
    }
}
