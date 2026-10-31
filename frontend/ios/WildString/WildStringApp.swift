import CorePlayback
import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        OfflineBackgroundEvents.store(completionHandler)
        OfflineBackgroundEvents.reconnect?()
    }
}

@main
struct WildStringApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

@MainActor
struct RootView: View {
    @State private var model = ConnectionModel()
    @AppStorage("appearanceTheme") private var theme = ThemeChoice.system.rawValue

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                ProgressView("正在连接…")
            case .servers:
                ServersView(model: model)
            case .connect:
                ConnectionView(model: model)
            case .connected(let server, let username):
                if let client = model.client, let playback = model.playback,
                    let favorites = model.favorites, let offline = model.offline,
                    let sharing = model.sharing
                {
                    MainTabView(
                        client: client,
                        playback: playback,
                        favorites: favorites,
                        offline: offline,
                        sharing: sharing,
                        isAdmin: model.profile == "owner",
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
            Self.applyDemoDefaults()
            await model.restore()
        }
        .preferredColorScheme((ThemeChoice(rawValue: theme) ?? .system).colorScheme)
    }

    private static func applyDemoDefaults() {
        #if DEBUG
            let environment = ProcessInfo.processInfo.environment
            if let style = environment["WILDSTRING_DEMO_PLAYER_STYLE"] {
                UserDefaults.standard.set(style, forKey: "playerStyle")
            }
            if let theme = environment["WILDSTRING_DEMO_THEME"] {
                UserDefaults.standard.set(theme, forKey: "appearanceTheme")
            }
            if let size = environment["WILDSTRING_DEMO_LIST_SIZE"] {
                UserDefaults.standard.set(size, forKey: "songListSize")
            }
            if let quality = environment["WILDSTRING_DEMO_QUALITY"] {
                UserDefaults.standard.set(quality, forKey: "playbackQuality")
            }
            if let syncMode = environment["WILDSTRING_DEMO_SYNC_MODE"] {
                UserDefaults.standard.set(syncMode, forKey: "playbackSyncMode")
            }
        #endif
    }
}
