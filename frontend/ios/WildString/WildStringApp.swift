import SwiftUI

@main
struct WildStringApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

@MainActor
struct RootView: View {
    @State private var model = ConnectionModel()

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                ProgressView("正在连接…")
            case .connect:
                ConnectionView(model: model)
            case .connected(let server, let username):
                ConnectedView(server: server, username: username) {
                    Task { await model.logout() }
                }
            }
        }
        .task {
            await model.restore()
        }
    }
}
