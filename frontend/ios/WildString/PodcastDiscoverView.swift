import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct PodcastDiscoverView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var query = ""
    @State private var region = ""
    @State private var page: PodcastDirectoryPage?
    @State private var selectedResult: PodcastDirectoryResult?
    @State private var preview: PodcastFeedPreview?
    @State private var loading = true
    @State private var previewing = false
    @State private var following = false
    @State private var canAdd = false
    @State private var errorMessage: String?
    @State private var previewError: String?
    @State private var retryToken = 0

    var body: some View {
        List {
            if query.isEmpty {
                Section {
                    Picker("区域", selection: $region) {
                        Text("服务器默认").tag("")
                        Text("中国大陆").tag("cn")
                        Text("香港").tag("hk")
                        Text("台湾").tag("tw")
                        Text("美国").tag("us")
                        Text("日本").tag("jp")
                        Text("英国").tag("gb")
                    }
                }
            }

            if let errorMessage {
                Section {
                    HStack {
                        Text(errorMessage).foregroundStyle(.red)
                        Spacer()
                        Button("重试") { retryToken += 1 }
                    }
                }
            }

            if let page, !page.failedRegions.isEmpty {
                Section {
                    Text("部分区域暂不可用：\(page.failedRegions.map(\.region).joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            Section(query.isEmpty ? "热门榜单" : "搜索结果") {
                if loading && (page == nil || page?.results.isEmpty == true) {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("正在加载播客目录…").foregroundStyle(.secondary)
                    }
                } else if let results = page?.results, !results.isEmpty {
                    ForEach(results) { result in
                        Button {
                            selectedResult = result
                            Task { await loadPreview(for: result) }
                        } label: {
                            HStack(spacing: 12) {
                                AsyncImage(url: URL(string: result.artworkURL)) { image in
                                    image.resizable().scaledToFill()
                                } placeholder: {
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(Color(.secondarySystemFill))
                                        .overlay(Image(systemName: "antenna.radiowaves.left.and.right").foregroundStyle(.secondary))
                                }
                                .frame(width: 52, height: 52)
                                .clipShape(RoundedRectangle(cornerRadius: 8))

                                VStack(alignment: .leading, spacing: 3) {
                                    Text(result.title)
                                        .font(.subheadline)
                                        .fontWeight(.medium)
                                        .lineLimit(2)
                                        .foregroundStyle(Color.primary)
                                    Text(result.author)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                    Text(result.followed ? "已关注" : result.genres.joined(separator: " · "))
                                        .font(.caption2)
                                        .foregroundStyle(result.followed ? Color.accentColor : .secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                } else if !loading {
                    ContentUnavailableView(
                        query.isEmpty ? "暂无热门推荐" : "未找到相关播客",
                        systemImage: "magnifyingglass",
                        description: Text(query.isEmpty ? "请尝试切换其他区域。" : "换个关键词试试。")
                    )
                }
            }
        }
        .navigationTitle("探索播客")
        .searchable(text: $query, prompt: "搜索播客名称或主题")
        .sheet(item: $selectedResult) { result in
            NavigationStack {
                previewSheet(result: result)
            }
        }
        .task {
            do {
                canAdd = try await client.canAddPodcasts()
            } catch {
                // Ignore failure to fetch policy
            }
        }
        .task(id: "\(query)|\(region)|\(retryToken)") {
            await fetchDirectory()
        }
    }

    @ViewBuilder
    private func previewSheet(result: PodcastDirectoryResult) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    AsyncImage(url: URL(string: result.artworkURL)) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 10)
                            .fill(Color(.secondarySystemFill))
                    }
                    .frame(width: 72, height: 72)
                    .clipShape(RoundedRectangle(cornerRadius: 10))

                    VStack(alignment: .leading, spacing: 4) {
                        Text(result.title)
                            .font(.headline)
                            .lineLimit(2)
                        Text(result.author)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if let count = preview?.episodeCount {
                            Text("\(count) 集")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if previewing {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("正在读取节目简介…").font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }

                if let preview {
                    if !preview.description.isEmpty {
                        Text(preview.description)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    Button {
                        Task { await followOrOpen(result: result, preview: preview) }
                    } label: {
                        HStack {
                            Spacer()
                            if following {
                                ProgressView()
                            } else {
                                Text(preview.followed ? "已关注 · 打开电台" : "关注节目")
                                    .fontWeight(.semibold)
                            }
                            Spacer()
                        }
                        .padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(following || (!canAdd && preview.catalogPodcastID == nil))

                    if !canAdd && preview.catalogPodcastID == nil {
                        Text("管理员尚未开放添加节目")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    if !preview.latestEpisodes.isEmpty {
                        Divider()
                        Text("最新单集")
                            .font(.headline)
                        ForEach(Array(preview.latestEpisodes.prefix(5).enumerated()), id: \.offset) { _, ep in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ep.title)
                                    .font(.subheadline)
                                    .lineLimit(2)
                                if let pub = ep.pubDate, !pub.isEmpty {
                                    Text(pub)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }

                if let previewError {
                    Text(previewError)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            .padding(20)
        }
        .navigationTitle("节目预览")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("完成") { selectedResult = nil }
            }
        }
    }

    private func fetchDirectory() async {
        let cleanQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleanQuery.isEmpty, let cached = PodcastDiscoveryCache.shared.get(region: region) {
            page = cached
            loading = false
            errorMessage = nil
            return
        }

        loading = true
        errorMessage = nil
        do {
            let fetched = try await client.podcastDirectory(
                query: cleanQuery,
                region: region
            )
            if cleanQuery.isEmpty {
                PodcastDiscoveryCache.shared.set(region: region, page: fetched)
            }
            page = fetched
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
        loading = false
    }

    private func loadPreview(for result: PodcastDirectoryResult) async {
        previewing = true
        previewError = nil
        preview = nil
        do {
            preview = try await client.previewPodcast(feedURL: result.feedURL)
        } catch {
            previewError = "无法获取节目预览：\(ErrorText.message(for: error))"
        }
        previewing = false
    }

    private func followOrOpen(result: PodcastDirectoryResult, preview: PodcastFeedPreview) async {
        following = true
        defer { following = false }
        do {
            if let catID = preview.catalogPodcastID {
                try await client.setPodcastFollowed(id: catID, followed: true)
            } else {
                _ = try await client.addPodcast(feedURL: result.feedURL, itunesID: result.itunesID)
            }
            selectedResult = nil
        } catch {
            previewError = "操作失败：\(ErrorText.message(for: error))"
        }
    }
}
