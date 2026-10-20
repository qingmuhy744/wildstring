import CoreNetwork
import SwiftUI
import UIKit

/// Album review workbench: compare current values with provider evidence,
/// select fields, then apply the chosen subset in one transaction.
@MainActor
struct MetadataReviewView: View {
    let client: WildstringClient
    var initialTrack: Track?

    @Environment(\.dismiss) private var dismiss
    @State private var albums: [ReviewAlbum] = []
    @State private var albumTotal = 0
    @State private var page: ReviewPage?
    @State private var tracks: [ReviewTrack] = []
    @State private var activeID = ""
    @State private var choices: [String: ReviewChoice] = [:]
    @State private var showAlbums = false
    @State private var showSongs = false
    @State private var showSources = false
    @State private var albumFilter = ""
    @State private var onlyChanges = true
    @State private var showOriginal = false
    @State private var tab = ReviewTab.fields
    @State private var coverDraft: Draft?
    @State private var coverAll = false
    @State private var coverReady = false
    @State private var coverFailed = false
    @State private var rejectionNotice: String?
    @State private var conflicts: Set<String> = []
    @State private var isWorking = false
    @State private var message: String?
    @State private var messageIsError = false
    @State private var operationKey = UUID().uuidString.lowercased()
    @State private var operationSignature = ""
    @State private var pageOffset = 0

    private struct ReviewChoice {
        var sourceID: String
        var fields: Set<String>
    }

    private enum ReviewTab: String, CaseIterable {
        case fields = "文字资料"
        case cover = "封面对比"
    }

    private static let fieldOrder = [
        "title", "artists", "album", "album_artists", "vocalists", "lyricists",
        "composers", "arrangers", "track_number", "disc_number", "track_total",
        "disc_total", "release_date", "original_date", "genres", "external_ids",
        "tags", "description",
    ]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        header
                        if showSongs {
                            songPicker
                        }
                        if let current {
                            activeTrack(current)
                        } else if page != nil, !isWorking {
                            Text("这个专辑没有待核对的候选。")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        if let message {
                            Text(message)
                                .font(.caption)
                                .foregroundStyle(messageIsError ? .red : .green)
                        }
                    }
                    .padding(16)
                }
                bottomBar
            }
            .navigationTitle("批量核对资料")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("重新读取") {
                        Task { await reloadKeepingActive() }
                    }
                    .disabled(isWorking)
                }
            }
            .task { await initialLoad() }
            .sheet(isPresented: $showAlbums) {
                albumPicker
            }
            .sheet(isPresented: $showSources) {
                sourcePicker
            }
        }
    }

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("先对比，再接受。人工值默认保留，勾选后会替换该字段。")
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                Button("选择专辑") { showAlbums = true }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                Button("勾选变化（保留人工值）") {
                    choices = Dictionary(
                        uniqueKeysWithValues: tracks.map { ($0.id, defaultChoice($0)) }
                    )
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isWorking || tracks.isEmpty)
                Button("清空") {
                    choices = choices.mapValues { ReviewChoice(sourceID: $0.sourceID, fields: []) }
                }
                .buttonStyle(.plain)
                .font(.footnote)
                .disabled(isWorking)
            }
            Text(page?.albumID == nil ? "暂无待核对专辑" : current?.album ?? "待核对专辑")
                .font(.headline)
                .lineLimit(1)
            Text("\(page?.total ?? 0) 首 · 本页 \(tracks.count) 首")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button(showSongs ? "收起歌曲列表" : "选择歌曲（已选 \(selectedTracks.count) 首）") {
                showSongs.toggle()
            }
            .font(.footnote)
        }
    }

    private var songPicker: some View {
        VStack(spacing: 0) {
            ForEach(tracks) { track in
                HStack(spacing: 10) {
                    Button {
                        let fields = choices[track.id]?.fields.isEmpty == false
                            ? []
                            : defaultChoice(track).fields
                        choose(track.id, fields: fields)
                    } label: {
                        Image(
                            systemName: choices[track.id]?.fields.isEmpty == false
                                ? "checkmark.circle.fill" : "circle"
                        )
                        .foregroundStyle(
                            choices[track.id]?.fields.isEmpty == false
                                ? Color.wildAccent : .secondary
                        )
                    }
                    .buttonStyle(.plain)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(track.title).font(.subheadline).lineLimit(1)
                        Text(
                            conflicts.contains(track.id)
                                ? "版本或候选冲突"
                                : "\(choices[track.id]?.fields.count ?? 0) 个字段已选"
                        )
                        .font(.caption2)
                        .foregroundStyle(conflicts.contains(track.id) ? .red : .secondary)
                    }
                    Spacer()
                }
                .padding(.vertical, 6)
                .contentShape(Rectangle())
                .onTapGesture {
                    activeID = track.id
                    showSongs = false
                    resetCover()
                }
                Divider()
            }
            if let page, page.total > 500 {
                HStack {
                    Button("上一页") {
                        Task {
                            await loadPage(
                                albumID: page.albumID,
                                offset: max(0, pageOffset - 500)
                            )
                        }
                    }
                    .disabled(isWorking || pageOffset == 0)
                    Spacer()
                    Button("下一页") {
                        Task {
                            await loadPage(
                                albumID: page.albumID,
                                offset: pageOffset + 500
                            )
                        }
                    }
                    .disabled(isWorking || pageOffset + 500 >= page.total)
                }
                .font(.footnote)
            }
        }
    }

    @ViewBuilder
    private func activeTrack(_ current: ReviewTrack) -> some View {
        let source = candidate(for: current)
        VStack(alignment: .leading, spacing: 8) {
            Text(current.title).font(.title3.bold())
            Text(current.artists.joined(separator: " / "))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(alignment: .top) {
                Button {
                    showSources = true
                } label: {
                    Text(source.map { candidateLabel($0, track: current) } ?? "选择候选来源")
                        .font(.footnote)
                        .multilineTextAlignment(.leading)
                        .lineLimit(3)
                }
                .buttonStyle(.plain)
                Spacer()
                Button("查询新资料") {
                    Task { await refreshCandidates(current) }
                }
                .font(.footnote)
                .disabled(isWorking)
            }
            if let source, (source.duplicateCount ?? 1) > 1 {
                Text("已合并 \(source.duplicateCount ?? 1) 条相同候选记录，不同版本分别保留。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Picker("内容", selection: $tab) {
                ForEach(ReviewTab.allCases, id: \.self) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            if tab == .fields {
                fieldsSection(current, source: source)
            } else {
                coverSection(current, source: source)
            }
        }
    }

    @ViewBuilder
    private func fieldsSection(_ current: ReviewTrack, source: ReviewCandidate?) -> some View {
        Toggle("只看变化字段", isOn: $onlyChanges)
            .font(.footnote)
        if let source {
            Text(
                "信息版本 \(source.metadataVersion)"
                    + (source.metadataVersion != current.metadataVersion ? " · 已过期，仅供核对" : "")
            )
            .font(.caption2)
            .foregroundStyle(
                source.metadataVersion != current.metadataVersion ? .orange : .secondary
            )
            if let url = source.sourceURL.flatMap(URL.init(string:)) {
                Link("查看来源依据", destination: url).font(.caption)
            }
        } else {
            Text("没有有效候选，可以查询资料或跳过。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if let source {
            let stale = source.metadataVersion != current.metadataVersion
            ForEach(visibleFieldKeys(source, track: current), id: \.self) { key in
                fieldCard(key, source: source, current: current, stale: stale)
            }
        }
        DisclosureGroup("文件原始值与匹配依据", isExpanded: $showOriginal) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(current.original.keys.sorted(), id: \.self) { key in
                    Text("\(fieldLabel(key))：\(current.original[key]?.display ?? "—")")
                        .font(.caption2)
                }
                if let match = source?.match {
                    Text(
                        "匹配方式：\(match.method ?? "未知")"
                            + (match.score.map { " · \(Int(($0 * 100).rounded()))%" } ?? "")
                    )
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
        .font(.footnote)
    }

    private func fieldCard(
        _ key: String,
        source: ReviewCandidate,
        current: ReviewTrack,
        stale: Bool
    ) -> some View {
        let chosen = choices[current.id]?.fields ?? []
        let selected = chosen.contains(key)
        let manual = current.overrides[key] != nil
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button {
                    Haptics.selection()
                    var fields = chosen
                    if selected { fields.remove(key) } else { fields.insert(key) }
                    choose(current.id, fields: fields, sourceID: source.id)
                } label: {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.wildAccent : .secondary)
                }
                .buttonStyle(.plain)
                .disabled(stale || isWorking)
                Text(fieldLabel(key)).font(.caption.bold())
                Spacer()
                if manual {
                    Text("人工值").font(.caption2).foregroundStyle(Color.wildAccent)
                }
            }
            Text("当前值").font(.caption2).foregroundStyle(.secondary)
            Text(current.current[key]?.display ?? "—")
                .font(.caption)
            Divider()
            Text("建议值").font(.caption2).foregroundStyle(Color.wildAccent)
            Text(source.fields[key]?.display ?? "—")
                .font(.caption)
            Button(
                selected
                    ? "本页同字段取消"
                    : "本页同字段勾选"
            ) {
                applyFieldToPage(key, selected: !selected)
            }
            .font(.caption2)
            .disabled(isWorking)
        }
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func coverSection(_ current: ReviewTrack, source: ReviewCandidate?) -> some View {
        Toggle("用于本页同专辑歌曲（\(coverAll ? tracks.count : 1) 首）", isOn: $coverAll)
            .font(.footnote)
            .onChange(of: coverAll) { _, _ in
                resetCover()
            }
        HStack(spacing: 12) {
            VStack(spacing: 4) {
                Text("当前封面").font(.caption2).foregroundStyle(.secondary)
                if current.hasCover {
                    CoverImage(client: client, trackID: current.id, size: 140)
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(.secondarySystemBackground))
                        .frame(width: 140, height: 140)
                        .overlay(Text("暂无封面").font(.caption2).foregroundStyle(.secondary))
                }
            }
            VStack(spacing: 4) {
                Text("将采用的封面").font(.caption2).foregroundStyle(.secondary)
                if let coverDraft {
                    ReviewCoverPreview(client: client, draftID: coverDraft.id) { ready in
                        coverReady = ready
                        coverFailed = !ready
                    }
                    .frame(width: 140, height: 140)
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(.secondarySystemBackground))
                        .frame(width: 140, height: 140)
                        .overlay(Text("尚未固定").font(.caption2).foregroundStyle(.secondary))
                }
            }
        }
        .frame(maxWidth: .infinity)
        Button("固定并预览此封面") {
            Task { await freezeCover(current, source: source) }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(
            isWorking || source?.coverURL == nil
                || source?.metadataVersion != current.metadataVersion
        )
        if coverFailed {
            Text("封面无法显示，本次不能应用。")
                .font(.caption)
                .foregroundStyle(.red)
        }
    }

    private var bottomBar: some View {
        VStack(spacing: 6) {
            Text(
                "已选 \(selectedTracks.count) 首 · "
                    + "\(selectedTracks.reduce(0) { $0 + (choices[$1.id]?.fields.count ?? 0) }) 个字段"
                    + (coverDraft != nil ? " · 含固定封面" : "")
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button("本次跳过") {
                    choices[activeID] = ReviewChoice(
                        sourceID: choices[activeID]?.sourceID ?? "",
                        fields: []
                    )
                    resetCover()
                    advance()
                }
                .buttonStyle(.bordered)
                .disabled(isWorking || current == nil)
                Button("接受选中项") {
                    Task { await acceptReview(single: false) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    isWorking
                        || (selectedTracks.isEmpty && coverDraft == nil)
                        || (coverDraft != nil && !coverReady)
                )
            }
            if let rejectionNotice {
                Text(rejectionNotice)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 8) {
                Button("拒绝当前建议") {
                    Task { await rejectCurrent() }
                }
                .font(.footnote)
                .disabled(isWorking || candidate(for: current) == nil)
                Spacer()
                Button("接受本曲并下一首") {
                    Task { await acceptReview(single: true) }
                }
                .font(.footnote)
                .disabled(
                    isWorking
                        || (choices[activeID]?.fields.isEmpty != false && coverDraft == nil)
                        || (coverDraft != nil && (coverAll || !coverReady))
                )
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var albumPicker: some View {
        NavigationStack {
            List {
                TextField("筛选专辑", text: $albumFilter)
                ForEach(
                    albums.filter {
                        albumFilter.isEmpty
                            || ($0.title + $0.artists.joined()).localizedCaseInsensitiveContains(
                                albumFilter
                            )
                    }
                ) { album in
                    Button {
                        showAlbums = false
                        Task { await loadPage(albumID: album.id) }
                    } label: {
                        HStack {
                            Text(album.title).lineLimit(1)
                            Spacer()
                            Text("\(album.count) 首")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if albums.count < albumTotal {
                    Button("更多专辑") {
                        Task { await loadAlbums(append: true) }
                    }
                }
            }
            .navigationTitle("待核对专辑")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("关闭") { showAlbums = false }
                }
            }
            .task { if albums.isEmpty { await loadAlbums() } }
        }
    }

    private var sourcePicker: some View {
        NavigationStack {
            List {
                if let current {
                    ForEach(current.suggestions) { candidate in
                        Button {
                            let fields = defaultFields(candidate, track: current)
                            choices[current.id] = ReviewChoice(
                                sourceID: candidate.id,
                                fields: fields
                            )
                            resetCover()
                            showSources = false
                        } label: {
                            Text(candidateLabel(candidate, track: current))
                                .font(.footnote)
                                .multilineTextAlignment(.leading)
                        }
                    }
                }
            }
            .navigationTitle("候选来源")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("关闭") { showSources = false }
                }
            }
        }
    }

    // MARK: - Data

    private var current: ReviewTrack? {
        tracks.first { $0.id == activeID }
    }

    private var selectedTracks: [ReviewTrack] {
        tracks.filter { choices[$0.id]?.fields.isEmpty == false }
    }

    private func candidate(for track: ReviewTrack?) -> ReviewCandidate? {
        guard let track else { return nil }
        guard let sourceID = choices[track.id]?.sourceID, !sourceID.isEmpty else {
            return track.suggestions.first {
                $0.metadataVersion == track.metadataVersion
            }
        }
        return track.suggestions.first { $0.id == sourceID }
    }

    private func defaultChoice(_ track: ReviewTrack) -> ReviewChoice {
        let source = track.suggestions.first { $0.metadataVersion == track.metadataVersion }
        return ReviewChoice(
            sourceID: source?.id ?? "",
            fields: source.map { defaultFields($0, track: track) } ?? []
        )
    }

    private func defaultFields(_ source: ReviewCandidate, track: ReviewTrack) -> Set<String> {
        guard source.metadataVersion == track.metadataVersion else { return [] }
        return Set(
            source.fields.keys.filter { key in
                track.overrides[key] == nil && track.current[key] != source.fields[key]
            }
        )
    }

    private func choose(_ trackID: String, fields: Set<String>, sourceID: String? = nil) {
        let existing = choices[trackID] ?? ReviewChoice(sourceID: "", fields: [])
        choices[trackID] = ReviewChoice(
            sourceID: sourceID ?? existing.sourceID,
            fields: fields
        )
    }

    private func applyFieldToPage(_ key: String, selected: Bool) {
        for track in tracks {
            guard let source = candidate(for: track),
                source.metadataVersion == track.metadataVersion,
                source.fields[key] != nil
            else { continue }
            var fields = choices[track.id]?.fields ?? []
            if selected { fields.insert(key) } else { fields.remove(key) }
            choose(track.id, fields: fields, sourceID: source.id)
        }
    }

    private func visibleFieldKeys(
        _ source: ReviewCandidate,
        track: ReviewTrack
    ) -> [String] {
        let keys = Self.fieldOrder.filter { source.fields[$0] != nil }
            + source.fields.keys.filter { !Self.fieldOrder.contains($0) }.sorted()
        guard onlyChanges else { return keys }
        return keys.filter { track.current[$0] != source.fields[$0] }
    }

    private func initialLoad() async {
        await loadAlbums()
        if let initialTrack {
            await loadPage(trackID: initialTrack.id, preferred: initialTrack.id)
        } else if let first = albums.first {
            await loadPage(albumID: first.id)
        }
    }

    private func loadAlbums(append: Bool = false) async {
        do {
            let offset = append ? albums.count : 0
            let value = try await client.reviewAlbums(limit: 100, offset: offset)
            albums = append ? albums + value.items : value.items
            albumTotal = value.total
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func loadPage(
        albumID: String? = nil,
        trackID: String? = nil,
        preferred: String? = nil,
        offset: Int = 0
    ) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let value = try await client.metadataReview(
                albumID: albumID,
                trackID: trackID,
                limit: 500,
                offset: offset
            )
            page = value
            tracks = value.items
            pageOffset = offset
            choices = Dictionary(
                uniqueKeysWithValues: value.items.map { ($0.id, defaultChoice($0)) }
            )
            activeID = preferred.flatMap { id in value.items.first { $0.id == id }?.id }
                ?? value.items.first { defaultChoice($0).fields.isEmpty == false }?.id
                ?? value.items.first?.id
                ?? ""
            conflicts = []
            rejectionNotice = nil
            resetCover()
            message = nil
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func reloadKeepingActive() async {
        let active = activeID
        await loadPage(
            albumID: page?.albumID,
            preferred: active
        )
    }

    private func advance() {
        guard let index = tracks.firstIndex(where: { $0.id == activeID }) else { return }
        activeID = tracks[(index + 1) % max(1, tracks.count)].id
        resetCover()
        message = nil
    }

    private func resetCover() {
        coverDraft = nil
        coverReady = false
        coverFailed = false
    }

    private func freezeCover(_ current: ReviewTrack, source: ReviewCandidate?) async {
        guard let source, let coverURL = source.coverURL, !coverURL.isEmpty else { return }
        guard source.metadataVersion == current.metadataVersion else { return }
        isWorking = true
        defer { isWorking = false }
        resetCover()
        do {
            let targets = (coverAll ? tracks : [current]).map {
                ReviewCoverTarget(trackID: $0.id, metadataVersion: $0.metadataVersion)
            }
            coverDraft = try await client.reviewCoverDraft(
                title: "封面核对 · \(current.album ?? current.title)",
                suggestionID: source.id,
                metadataVersion: current.metadataVersion,
                targets: targets
            )
            message = nil
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func refreshCandidates(_ track: ReviewTrack) async {
        isWorking = true
        defer { isWorking = false }
        do {
            let queued = try await client.refreshProviderMetadata(
                trackID: track.id,
                mode: "missing",
                force: false
            )
            message = "已排队 \(queued.queued) 首，查询完成后重新读取。"
            messageIsError = false
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func rejectCurrent() async {
        guard let current, let source = candidate(for: current) else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await client.rejectReview(
                trackID: current.id,
                suggestionID: source.id,
                metadataVersion: current.metadataVersion,
                candidateDigest: source.candidateDigest
            )
            rejectionNotice = "已拒绝当前候选，现有资料保持不变。"
            await loadPage(
                albumID: page?.albumID,
                preferred: current.id
            )
            await loadAlbums()
            rejectionNotice = "已拒绝当前候选，现有资料保持不变。"
        } catch let error as APIError where error.statusCode == 404 || error.statusCode == 405 {
            message = "服务端版本较旧，请升级到 0.5.12 后使用拒绝。"
            messageIsError = true
        } catch let error as APIError where error.statusCode == 409 {
            await reloadKeepingActive()
            message = "候选或歌曲信息已变化，已刷新，请重新核对。"
            messageIsError = true
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func acceptReview(single: Bool) async {
        guard !isWorking else { return }
        let chosen = single
            ? selectedTracks.filter { $0.id == activeID }
            : selectedTracks
        if chosen.isEmpty, coverDraft == nil { return }
        isWorking = true
        defer { isWorking = false }
        do {
            var items: [ReviewAcceptItem] = []
            for track in chosen {
                guard let source = candidate(for: track),
                    let fields = choices[track.id]?.fields,
                    !fields.isEmpty
                else { continue }
                items.append(
                    ReviewAcceptItem(
                        trackID: track.id,
                        suggestionID: source.id,
                        metadataVersion: track.metadataVersion,
                        candidateDigest: source.candidateDigest,
                        fields: Array(fields)
                    )
                )
            }
            let signature = items.map {
                "\($0.trackID):\($0.fields.sorted().joined(separator: ","))"
            }.joined(separator: "|")
                + "|cover:\(coverDraft?.id ?? "")"
                + "|targets:\(coverAll ? "page" : "track")"
            if signature != operationSignature {
                operationSignature = signature
                operationKey = UUID().uuidString.lowercased()
            }
            let nextID: String?
            if single, let index = tracks.firstIndex(where: { $0.id == activeID }) {
                nextID = tracks[(index + 1) % max(1, tracks.count)].id
            } else {
                nextID = nil
            }
            if !items.isEmpty {
                let result = try await client.acceptReview(
                    items: items,
                    coverDraftID: coverDraft?.id,
                    idempotencyKey: operationKey
                )
                guard result.status == "applied" else {
                    conflicts = Set(result.conflicts?.map(\.trackID) ?? [])
                    message = "此批次未应用：歌曲或候选已变化，请重新读取后核对。"
                    messageIsError = true
                    return
                }
            } else if let coverDraft {
                _ = try await client.acceptDraft(
                    id: coverDraft.id,
                    version: coverDraft.version,
                    previewDigest: coverDraft.previewDigest,
                    idempotencyKey: operationKey
                )
            }
            let appliedCount = items.count
            let hadCover = coverDraft != nil
            await loadPage(
                albumID: page?.albumID,
                preferred: nextID
            )
            await loadAlbums()
            message = "已应用 \(appliedCount) 首的所选资料"
                + (hadCover ? "及固定封面。" : "。")
            messageIsError = false
        } catch let error as APIError where error.statusCode == 409 {
            await reloadKeepingActive()
            message = "歌曲信息或候选已变化，已刷新，请重新核对。"
            messageIsError = true
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    // MARK: - Labels

    private func fieldLabel(_ key: String) -> String {
        switch key {
        case "title": "歌名"
        case "artists": "歌曲艺人"
        case "album": "专辑"
        case "album_artists": "专辑艺人"
        case "vocalists": "演唱"
        case "lyricists": "作词"
        case "composers": "作曲"
        case "arrangers": "编曲"
        case "track_number": "曲序"
        case "disc_number": "碟号"
        case "track_total": "总曲数"
        case "disc_total": "总碟数"
        case "release_date": "发行日期"
        case "original_date": "首次发行日期"
        case "genres": "风格"
        case "external_ids": "外部标识"
        case "tags": "标签"
        case "description": "简介"
        default: key
        }
    }

    private func candidateLabel(_ source: ReviewCandidate, track: ReviewTrack) -> String {
        var parts = [page?.providerNames[source.provider] ?? source.provider]
        if let title = source.fields["title"]?.display, !title.isEmpty, title != track.title {
            parts.append(title)
        }
        parts.append(source.fields["album"]?.display ?? "未提供专辑")
        if let date = source.fields["release_date"]?.display, !date.isEmpty {
            parts.append(date)
        }
        if let score = source.match?.score {
            parts.append("匹配度 \(Int((score * 100).rounded()))%")
        }
        if source.metadataVersion != track.metadataVersion {
            parts.append("已过期")
        }
        return parts.joined(separator: " · ")
    }
}

/// Server-frozen cover snapshot draft preview.
@MainActor
private struct ReviewCoverPreview: View {
    let client: WildstringClient
    let draftID: String
    let onReady: (Bool) -> Void

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                ProgressView()
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task(id: draftID) { await load() }
    }

    private func load() async {
        do {
            let data = try await client.draftCoverPreview(id: draftID)
            guard let loaded = UIImage(data: data) else {
                onReady(false)
                return
            }
            image = loaded
            onReady(true)
        } catch {
            onReady(false)
        }
    }
}
