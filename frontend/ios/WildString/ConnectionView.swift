import SwiftUI

@MainActor
struct ConnectionView: View {
    @Bindable var model: ConnectionModel

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://music.example.com", text: $model.serverText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .textContentType(.URL)
                } header: {
                    Text("服务器地址")
                } footer: {
                    Text("填写自托管实例的地址；开发版允许 http://127.0.0.1。")
                }

                Section("账号") {
                    TextField("用户名", text: $model.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                    SecureField("密码", text: $model.password)
                        .textContentType(.password)
                }

                if let message = model.errorMessage {
                    Section {
                        Text(message)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await model.login() }
                    } label: {
                        HStack {
                            Spacer()
                            if model.isBusy {
                                ProgressView()
                            } else {
                                Text("连接并登录").bold()
                            }
                            Spacer()
                        }
                    }
                    .disabled(model.isBusy || !model.canSubmit)
                }
            }
            .navigationTitle("野弦")
        }
    }
}
