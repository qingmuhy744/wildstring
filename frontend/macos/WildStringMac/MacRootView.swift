import CoreNetwork
import CorePlayback
import SwiftUI

struct MacRootView: View {
    let session: MacSession
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            switch session.phase {
            case .loading:
                ProgressView("正在连接…")
                    .frame(minWidth: 720, minHeight: 480)
            case .connect:
                MacLoginView(session: session)
            case .connected:
                if let client = session.client, let playback = session.playback {
                    MacShellView(session: session, client: client, playback: playback)
                } else {
                    ProgressView()
                }
            }
        }
        .frame(minWidth: 960, minHeight: 640)
        .onReceive(NotificationCenter.default.publisher(for: .wildstringShowDesktopLyrics)) { _ in
            openWindow(id: "desktop-lyrics")
        }
        .task { await session.restore() }
    }
}

private struct MacLoginView: View {
    let session: MacSession

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("连接到野弦")
                .font(.title2.bold())
            TextField("服务器地址", text: Bindable(session).serverText)
                .textFieldStyle(.roundedBorder)
            TextField("用户名", text: Bindable(session).username)
                .textFieldStyle(.roundedBorder)
            SecureField("密码", text: Bindable(session).password)
                .textFieldStyle(.roundedBorder)
            Toggle("允许未加密的 HTTP", isOn: Bindable(session).allowInsecureHTTP)
            if let errorMessage = session.errorMessage {
                Text(errorMessage)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            Button(session.isBusy ? "正在连接…" : "连接") {
                Task { await session.login() }
            }
            .keyboardShortcut(.defaultAction)
            .disabled(session.isBusy || session.serverText.isEmpty || session.username.isEmpty || session.password.isEmpty)
            if !session.servers.isEmpty {
                Text("最近的服务器")
                    .font(.headline)
                ForEach(session.servers) { server in
                    Button("\(server.username) · \(server.address)") {
                        session.serverText = server.address
                        session.username = server.username
                        session.allowInsecureHTTP = server.allowInsecureHTTP
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(28)
        .frame(width: 420)
    }
}

private struct MacShellView: View {
    let session: MacSession
    let client: WildstringClient
    let playback: PlaybackService

    var body: some View {
        NavigationSplitView {
            List(MacPage.allCases, selection: Bindable(session).page) { page in
                Label(page.title, systemImage: page.symbol)
                    .tag(page)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
            .navigationTitle("野弦")
        } content: {
            switch session.page {
            case .music:
                MacMusicView(client: client, playback: playback)
            case .discover:
                MacDiscoverView(client: client, playback: playback)
            case .podcasts:
                MacPodcastsView(client: client, playback: playback)
            case .settings:
                MacSettingsView(session: session)
            }
        } detail: {
            MacPlayerPane(session: session, client: client, playback: playback)
        }
    }
}
