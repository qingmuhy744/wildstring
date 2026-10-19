import CorePlayback
import SwiftUI

@MainActor
struct AccountView: View {
    let server: String
    let username: String
    let playback: PlaybackService
    let onLogout: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section("账号") {
                    LabeledContent("用户名", value: username)
                    LabeledContent("服务器", value: server)
                }
                Section("即将上线") {
                    Text("收藏、歌单与设置将在后续批次加入。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section {
                    Button("退出登录", role: .destructive, action: onLogout)
                }
            }
            .navigationTitle("我的")
            .miniPlayer(playback)
        }
    }
}
