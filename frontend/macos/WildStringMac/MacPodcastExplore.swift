import CoreNetwork
import SwiftUI

struct MacPodcastExplore: View {
    let client: WildstringClient
    let onFollowed: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var region = ""
    @State private var page: PodcastDirectoryPage?
    @State private var selected: PodcastDirectoryResult?
    @State private var preview: PodcastFeedPreview?
    @State private var loading = true
    @State private var previewing = false
    @State private var adding = false
    @State private var canAdd = false
    @State private var error: String?
    @State private var previewError: String?
    @State private var retry = 0

    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Button { dismiss() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain).accessibilityLabel("关闭探索")
                Text("探索播客").font(.title2.bold())
                Spacer()
                Picker("区域", selection: $region) {
                    Text("服务器默认").tag("")
                    Text("台湾").tag("tw"); Text("中国大陆").tag("cn")
                    Text("香港").tag("hk"); Text("美国").tag("us")
                    Text("日本").tag("jp"); Text("英国").tag("gb")
                }.frame(width: 185).disabled(!query.isEmpty)
            }
            TextField("搜索节目名称，留空浏览区域热门榜", text: $query).textFieldStyle(.roundedBorder)
            HStack {
                Text(query.isEmpty ? "Apple Podcasts 区域热门 · \(page?.regions.joined(separator: ", ").uppercased() ?? "")" : "Apple Podcasts 目录搜索")
                Spacer()
                if loading { ProgressView().controlSize(.small) }
            }.font(.caption).foregroundStyle(.secondary)
            if let error {
                HStack { Text(error).foregroundStyle(.secondary); Button("重试") { retry += 1 } }
            }
            if let page, !page.failedRegions.isEmpty {
                Text("部分区域暂不可用：\(page.failedRegions.map(\.region).joined(separator: ", "))").font(.caption).foregroundStyle(.orange)
            }
            HSplitView {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(page?.results ?? []) { result in
                            Button { selected = result } label: {
                                HStack(spacing: 12) {
                                    MacPodcastArtwork(url: URL(string: result.artworkURL), side: 54)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(result.title).font(.headline).lineLimit(2)
                                        Text(result.author).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                        Text(result.followed ? "已关注" : result.explicit ? "成人内容" : result.genres.joined(separator: " · "))
                                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }.padding(10)
                                    .background(selected?.id == result.id ? MacTheme.accent.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 10))
                            }.buttonStyle(.plain)
                        }
                        if page?.results.isEmpty == true && !loading { Text("暂无节目，试试其他区域或关键词").foregroundStyle(.secondary).padding() }
                    }
                }.frame(minWidth: 280, idealWidth: 320)
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let selected {
                            Text(selected.title).font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
                            if previewing { ProgressView("正在预览…") }
                            if let preview {
                                Text("\(preview.author) · \(preview.episodeCount) 集").foregroundStyle(.secondary)
                                Text(MacPodcastArticle.render(preview.description, duration: 0)).textSelection(.enabled)
                                Text("最新单集").font(.headline)
                                ForEach(Array(preview.latestEpisodes.enumerated()), id: \.offset) { _, episode in
                                    Text(episode.title).font(.callout).fixedSize(horizontal: false, vertical: true)
                                }
                                Button(adding ? "正在关注…" : preview.followed ? "打开节目" : "关注节目") { Task { await follow(selected, preview: preview) } }
                                    .buttonStyle(.borderedProminent)
                                    .disabled(adding || (!canAdd && preview.catalogPodcastID == nil))
                                if !canAdd && preview.catalogPodcastID == nil { Text("管理员尚未开放添加节目").font(.caption).foregroundStyle(.secondary) }
                            }
                            if let previewError { Text(previewError).foregroundStyle(.orange) }
                        } else {
                            ContentUnavailableView("发现下一档喜欢的节目", systemImage: "antenna.radiowaves.left.and.right", description: Text("选择节目查看简介和最新单集，关注后加入你的电台。"))
                        }
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(minWidth: 330)
            }
        }.padding(24).frame(width: 840, height: 620)
        .task { do { canAdd = try await client.canAddPodcasts() } catch { self.error = MacErrorText.message(for: error) } }
        .task(id: "\(query)|\(region)|\(retry)") {
            page = nil; error = nil; loading = true; selected = nil
            do {
                try await Task.sleep(for: .milliseconds(350))
                let result = try await client.podcastDirectory(query: query.trimmingCharacters(in: .whitespacesAndNewlines), region: region)
                guard !Task.isCancelled else { return }
                page = result; loading = false
            } catch {
                guard !Task.isCancelled else { return }
                self.error = MacErrorText.message(for: error); loading = false
            }
        }
        .task(id: selected?.id) {
            preview = nil; previewError = nil
            guard let selected else { return }
            previewing = true
            do {
                let result = try await client.previewPodcast(feedURL: selected.feedURL)
                guard !Task.isCancelled else { return }
                preview = result; previewing = false
            } catch {
                guard !Task.isCancelled else { return }
                previewError = MacErrorText.message(for: error); previewing = false
            }
        }
    }

    private func follow(_ selected: PodcastDirectoryResult, preview: PodcastFeedPreview) async {
        adding = true; previewError = nil
        defer { adding = false }
        do {
            let id: String
            if let existing = preview.catalogPodcastID {
                if !preview.followed { try await client.setPodcastFollowed(id: existing, followed: true) }
                id = existing
            } else {
                id = try await client.addPodcast(feedURL: selected.feedURL, itunesID: selected.itunesID).podcast.id
            }
            onFollowed(id); dismiss()
        } catch { previewError = MacErrorText.message(for: error) }
    }
}
