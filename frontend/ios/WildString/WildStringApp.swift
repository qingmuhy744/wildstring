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
                if let client = model.client, let playback = model.playback {
                    LibraryView(
                        client: client,
                        playback: playback,
                        server: server,
                        username: username,
                        autoPlayFirst: model.demoAutoPlay,
                        onLogout: { Task { await model.logout() } }
                    )
                } else {
                    ProgressView()
                }
            }
        }
        .task {
            await model.restore()
        }
    }
}
