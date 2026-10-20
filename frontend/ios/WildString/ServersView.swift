import SwiftUI

/// Saved servers: tap to switch, swipe to delete (clears that server's
/// session, caches, offline copies and queue space).
@MainActor
struct ServersView: View {
    @Bindable var model: ConnectionModel

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
                                    Text(server.address)
                                        .lineLimit(1)
                                    Text(server.username)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .buttonStyle(.plain)
                            .swipeActions {
                                Button("删除", role: .destructive) {
                                    Task { await model.deleteServer(server) }
                                }
                            }
                        }
                    }
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
        }
    }
}
