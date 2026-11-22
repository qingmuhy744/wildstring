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
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("appearanceTheme") private var theme = ThemeChoice.system.rawValue
    @AppStorage(InterfaceLanguage.storageKey) private var language = InterfaceLanguage.auto.rawValue

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                ProgressView("connection.connecting")
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
                        profile: model.profile ?? "listener",
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
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.playback?.podcastCloud?.refreshResumeMode() } }
        }
        .confirmationDialog(L10n("podcasts.resumeDialogTitle"), isPresented: Binding(
            get: { model.playback?.podcastResumePrompt != nil },
            set: { if !$0 { model.playback?.answerPodcastResume(restart: nil) } }
        ), titleVisibility: .visible) {
            Button(L10n("podcasts.resume")) { model.playback?.answerPodcastResume(restart: false) }
            Button(L10n("podcasts.playFromBeginning")) { model.playback?.answerPodcastResume(restart: true) }
            Button(L10n("podcasts.cancel"), role: .cancel) { model.playback?.answerPodcastResume(restart: nil) }
        } message: {
            if let prompt = model.playback?.podcastResumePrompt {
                Text(L10n("podcasts.listenedProgress", Self.clock(prompt.position), Self.clock(prompt.duration)))
            }
        }
        .environment(model)
        .preferredColorScheme((ThemeChoice(rawValue: theme) ?? .system).colorScheme)
        .environment(\.locale, InterfaceLanguage(preference: language).locale)
    }

    private static func clock(_ seconds: Int) -> String { String(format: "%d:%02d", seconds / 60, seconds % 60) }

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
