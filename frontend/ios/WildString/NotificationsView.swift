import CoreNetwork
import SwiftUI

/// In-app notification inbox; reading the list never marks items read.
@MainActor
struct NotificationsView: View {
    let client: WildstringClient

    @State private var items: [AppNotification] = []
    @State private var unreadCount = 0
    @State private var highWatermark = 0
    @State private var filter: Filter = .unread
    @State private var isLoading = true
    @State private var message: String?
    @State private var showingDrafts = false

    private enum Filter: String, CaseIterable {
        case unread = "未读"
        case read = "已读"
        case all = "全部"
    }

    var body: some View {
        List {
            if filtered.isEmpty, !isLoading {
                ContentUnavailableView(
                    emptyTitle,
                    systemImage: "bell",
                    description: Text("后台整理和建议的结果会出现在这里。")
                )
            }
            ForEach(filtered) { notification in
                Button {
                    Task { await open(notification) }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            if notification.isUnread {
                                Circle()
                                    .fill(Color.wildAccent)
                                    .frame(width: 7, height: 7)
                            }
                            Text(notification.title)
                                .font(.subheadline.bold())
                                .foregroundStyle(.primary)
                            Spacer()
                            if let severity = notification.severity, severity != "info" {
                                Text(severity == "error" ? "错误" : "提醒")
                                    .font(.caption2)
                                    .foregroundStyle(severity == "error" ? .red : .orange)
                            }
                        }
                        Text(notification.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                        HStack {
                            Text(dateText(notification.createdAt))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            Spacer()
                            if notification.draftID != nil {
                                Text("查看草案")
                                    .font(.caption2)
                                    .foregroundStyle(Color.wildAccent)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
                .buttonStyle(.plain)
                .swipeActions {
                    if notification.isUnread {
                        Button("标为已读") {
                            Task { await markRead([notification]) }
                        }
                        .tint(.accentColor)
                    }
                }
            }
            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .listStyle(.plain)
        .safeAreaInset(edge: .top) {
            Picker("筛选", selection: $filter) {
                ForEach(Filter.allCases, id: \.self) { value in
                    Text(value.rawValue).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .background(.bar)
        }
        .navigationTitle("通知")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("全部已读") {
                    Task { await markAllRead() }
                }
                .disabled(unreadCount == 0 || isLoading)
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showingDrafts) {
            DraftsView(client: client)
        }
    }

    private var filtered: [AppNotification] {
        switch filter {
        case .unread: items.filter(\.isUnread)
        case .read: items.filter { !$0.isUnread }
        case .all: items
        }
    }

    private var emptyTitle: String {
        switch filter {
        case .unread: "没有未读通知"
        case .read: "暂无已读记录"
        case .all: "还没有通知"
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await client.notifications(limit: 100)
            items = page.items
            unreadCount = page.unreadCount
            highWatermark = page.highWatermark
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func open(_ notification: AppNotification) async {
        if notification.isUnread {
            await markRead([notification])
        }
        if notification.draftID != nil {
            showingDrafts = true
        }
    }

    private func markRead(_ targets: [AppNotification]) async {
        let ids = targets.map(\.id)
        do {
            try await client.markNotificationsRead(ids: ids)
            let now = ISO8601DateFormatter().string(from: Date())
            items = items.map { item in
                guard ids.contains(item.id) else { return item }
                return AppNotification(
                    id: item.id,
                    eventType: item.eventType,
                    title: item.title,
                    summary: item.summary,
                    severity: item.severity,
                    taskID: item.taskID,
                    draftID: item.draftID,
                    traceID: item.traceID,
                    createdAt: item.createdAt,
                    readAt: item.readAt ?? now,
                    detailRoute: item.detailRoute
                )
            }
            unreadCount = max(0, unreadCount - ids.count)
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func markAllRead() async {
        do {
            try await client.markAllNotificationsRead(highWatermark: highWatermark)
            await load()
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func dateText(_ value: String) -> String {
        let formatted = value.replacingOccurrences(of: "T", with: " ")
        return String(formatted.prefix(16))
    }
}
