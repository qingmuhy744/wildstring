import CoreNetwork
import Foundation
import Testing

@testable import WildString

@Suite("Mac assistant", .serialized)
@MainActor
struct MacAssistantTests {
    private func model() throws -> MacAssistantModel {
        MacAssistantModel(
            client: WildstringClient(
                server: try ServerAddress(input: "music.example.com"),
                store: InMemorySessionStore(), configuration: StubURLProtocol.configuration()
            ))
    }

    nonisolated private static let empty = #"{"id":"c1","title":"测试对话","messages":[],"runs":[]}"#
    nonisolated private static let completed =
        #"{"id":"c1","title":"测试对话","messages":[{"id":"u1","role":"user","content":"夜曲"},{"id":"a1","role":"assistant","content":"已找到"}],"runs":[{"id":"r1","status":"succeeded","draft_ids":["d1"]}]}"#
    nonisolated private static let page = #"{"items":[],"total":0,"offset":0,"limit":100}"#

    @Test func openingAssistantDoesNotCreateAnEmptyConversation() async throws {
        StubURLProtocol.respond { request in
            #expect(request.httpMethod == "GET")
            return .json(body: Self.page)
        }
        let model = try model()
        await model.prepare()
        model.newConversation()
        #expect(model.detail == nil)
        #expect(StubURLProtocol.requests.count == 2)
    }

    @Test func failedSendKeepsInputAndShowsError() async throws {
        StubURLProtocol.respond { request in
            let path = request.url!.path
            if path.hasSuffix("/messages") { throw URLError(.notConnectedToInternet) }
            if path.hasSuffix("/c1") || request.httpMethod == "POST" {
                return .json(body: Self.empty)
            }
            return .json(body: Self.page)
        }
        let model = try model()
        model.input = "夜曲"
        await model.send()
        #expect(model.input == "夜曲")
        #expect(model.errorMessage != nil)
        #expect(!model.isSending)
        #expect(model.canSend)
    }

    @Test func timeoutAfterAcceptanceRecoversReplyWithoutOfferingDuplicateSend() async throws {
        StubURLProtocol.respond { request in
            if request.url!.path.hasSuffix("/messages") { throw URLError(.timedOut) }
            if request.url!.path.hasSuffix("/c1") { return .json(body: Self.completed) }
            if request.httpMethod == "POST" { return .json(body: Self.empty) }
            return .json(body: Self.page)
        }
        let model = try model()
        model.input = "夜曲"
        await model.send()
        #expect(model.input.isEmpty)
        #expect(model.detail?.messages.last?.content == "已找到")
        #expect(model.draftIDs == ["d1"])
        #expect(!model.canSend)
        #expect(StubURLProtocol.requests.filter { $0.url!.path.hasSuffix("/messages") }.count == 1)
    }

    @Test func repeatedSendWhileAwaitingReplyCreatesOnlyOneTurn() async throws {
        StubURLProtocol.respond { request in
            if request.url!.path.hasSuffix("/messages") { return .json(body: Self.completed) }
            if request.httpMethod == "POST" { return .json(body: Self.empty) }
            return .json(body: Self.page)
        }
        let model = try model()
        model.input = "夜曲"
        async let first: Void = model.send()
        async let second: Void = model.send()
        _ = await (first, second)
        #expect(StubURLProtocol.requests.filter { $0.url!.path.hasSuffix("/messages") }.count == 1)
        #expect(model.input.isEmpty)
    }

    @Test func runningServerTurnBlocksNavigationAndResending() async throws {
        StubURLProtocol.respond { _ in
            .json(
                body:
                    #"{"id":"c1","title":"运行中","connection_id":"model-1","messages":[],"runs":[{"id":"r1","status":"running","stage":"tools","draft_ids":[]}]}"#
            )
        }
        let model = try model()
        await model.open("c1")
        model.input = "另一条消息"
        #expect(model.running)
        #expect(!model.canSend)
        #expect(model.pollingID == "c1")
        model.newConversation()
        await model.send()
        #expect(model.detail?.id == "c1")
        #expect(StubURLProtocol.requests.count == 1)
    }

    @Test func unavailableModelDoesNotSilentlyFallBackOrSend() async throws {
        let model = try model()
        model.connectionID = "removed-model"
        model.input = "生成歌单"
        #expect(!model.canSend)
        await model.send()
        #expect(model.detail == nil)
        #expect(model.input == "生成歌单")
    }
}
