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
        case unread
        case read
        case all

        var title: String {
            switch self {
            case .unread: return L10n("notifications.filterUnread")
            case .read: return L10n("notifications.filterRead")
            case .all: return L10n("notifications.filterAll")
            }
        }
    }

    var body: some View {
        List {
            if filtered.isEmpty, !isLoading {
                ContentUnavailableView(
                    emptyTitle,
                    systemImage: "bell",
                    description: Text(L10n("notifications.emptyDescription"))
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
                                Text(severity == "error" ? L10n("notifications.severityError") : L10n("notifications.severityWarning"))
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
                                Text(L10n("notifications.viewDraft"))
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
                        Button(L10n("notifications.markRead")) {
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
            Picker(L10n("notifications.filter"), selection: $filter) {
                ForEach(Filter.allCases, id: \.self) { value in
                    Text(value.title).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .background(.bar)
        }
        .navigationTitle(L10n("notifications.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(L10n("notifications.markAllRead")) {
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
        case .unread: L10n("notifications.emptyUnread")
        case .read: L10n("notifications.emptyRead")
        case .all: L10n("notifications.emptyAll")
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
