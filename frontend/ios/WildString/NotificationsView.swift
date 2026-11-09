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
                            Text(localizedTitle(notification.title))
                                .font(.subheadline.bold())
                                .foregroundStyle(.primary)
                            Spacer()
                            if let severity = notification.severity, severity != "info" {
                                Text(severity == "error" ? L10n("notifications.severityError") : L10n("notifications.severityWarning"))
                                    .font(.caption2)
                                    .foregroundStyle(severity == "error" ? .red : .orange)
                            }
                        }
                        Text(localizedSummary(notification.summary))
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

    private func localizedTitle(_ title: String) -> String {
        switch title {
        case "整理方式已更新", "整理结果的自动处理方式已更新": return L10n("notifications.event.titlePolicyUpdated")
        case "曲库巡检完成", "曲库巡检已完成": return L10n("notifications.event.titleInspectionDone")
        case "曲库巡检需要处理", "曲库巡检未完全完成": return L10n("notifications.event.titleInspectionPartial")
        case "草案待确认", "曲库整理草案待确认", "导入整理草案待确认": return L10n("notifications.event.titleCurationDraftPending")
        case "草案已应用", "曲库整理已自动应用": return L10n("notifications.event.titleCurationAutoApplied")
        case "歌词补全与洗版扫描结束", "全库歌词扫描已完成", "专辑歌词扫描已完成": return L10n("notifications.event.titleLyricLibraryDone")
        case "导入任务结束", "扫描任务结束", "曲库导入或扫描已完成": return L10n("notifications.event.titleImportDone")
        case "元数据查询结束", "元数据批量查询已完成": return L10n("notifications.event.titleMetadataBatchDone")
        default: return title
        }
    }

    private func localizedSummary(_ summary: String) -> String {
        switch summary {
        case "自动应用": return L10n("notifications.event.summaryAutoApply")
        case "审核后应用": return L10n("notifications.event.summaryManualReview")
        case "任务已完成，请到曲库管理查看逐项结果。": return L10n("notifications.event.summaryLibSuccess")
        case "任务已结束，存在需要处理的项目，请到曲库管理查看结果。": return L10n("notifications.event.summaryLibWarning")
        default: break
        }
        if let m = try? /^已检查 (\d+) 首，发现 (\d+) 项，失败 (\d+) 首。(?: 错误：(.+))?$/.wholeMatch(in: summary),
           let processed = Int(m.1), let issues = Int(m.2), let failed = Int(m.3) {
            let base = L10n("notifications.event.summaryInspCounts", processed, issues, failed)
            if let err = m.4 { return base + L10n("notifications.event.summaryInspErrSuffix", String(err)) }
            return base
        }
        if let m = try? /^可升级 (\d+) 首，待核对 (\d+) 首，未匹配 (\d+) 首，失败 (\d+) 首。请到歌词补全查看并确认。$/.wholeMatch(in: summary),
           let ready = Int(m.1), let review = Int(m.2), let noMatch = Int(m.3), let failed = Int(m.4) {
            return L10n("notifications.event.summaryLyricCounts", ready, review, noMatch, failed)
        }
        if let m = try? /^查询结束：建议已生成 (\d+) 首，未匹配 (\d+) 首，失败 (\d+) 首，已变化 (\d+) 首。建议需要确认后应用。(?:其中 (\d+) 首有来源警告。)?$/.wholeMatch(in: summary),
           let completed = Int(m.1), let noMatch = Int(m.2), let failed = Int(m.3), let stale = Int(m.4) {
            let base = L10n("notifications.event.summaryMetaCounts", completed, noMatch, failed, stale)
            if let warnStr = m.5, let warn = Int(warnStr) { return base + L10n("notifications.event.summaryMetaWarnSuffix", warn) }
            return base
        }
        return summary
    }
}
