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
                    Section(L10n("serversView.savedServersSection")) {
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
                                Button(L10n("serversView.localAlias")) { alias = server.alias ?? ""; editing = server }
                            }
                            .swipeActions {
                                Button(L10n("serversView.delete"), role: .destructive) {
                                    Task { await model.deleteServer(server) }
                                }
                            }
                        }
                    }
                }
                if model.routes != nil {
                    Section { Button(L10n("serversView.currentServerRoutes")) { showRoutes = true } }
                }
                Section {
                    Button {
                        model.showAddServer()
                    } label: {
                        Label(L10n("serversView.addServer"), systemImage: "plus")
                    }
                } footer: {
                    Text(L10n("serversView.serverNotice"))
                }
                if let message = model.errorMessage {
                    Section {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(L10n("serversView.brandTitle"))
            .sheet(isPresented: $showRoutes) {
                if let routes = model.routes {
                    NavigationStack { ServerRoutesEditor(routes: routes).navigationTitle(L10n("serversView.serverRoutesTitle")).toolbar { Button(L10n("serversView.done")) { showRoutes = false } } }
                }
            }
            .alert(L10n("serversView.localAliasTitle"), isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
                TextField(L10n("serversView.aliasPlaceholder"), text: $alias)
                Button(L10n("serversView.save")) { if let editing { model.setAlias(alias, for: editing) }; editing = nil }
                Button(L10n("serversView.cancel"), role: .cancel) { editing = nil }
            } message: { Text(L10n("serversView.aliasNotice")) }
        }
    }
}
