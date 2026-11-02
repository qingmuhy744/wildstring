import CoreNetwork
import Foundation
import Network
import Testing

@testable import WildString

extension MacAssistantTests {
  @Test func searchLoadsTracksAlbumsAndArtistsTogether() async throws {
    StubURLProtocol.respond { request in
      let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
        .queryItems?.first(where: { $0.name == "q" })?.value
      #expect(query == "海边")
      switch request.url!.path {
      case "/api/v1/tracks":
        return .json(
          body:
            #"{"items":[{"id":"track-sea","title":"海边","artists":["测试歌手"],"album":"远方","duration_ms":180000,"has_cover":false,"album_id":"album-sea"}],"total":1,"limit":80,"offset":0}"#
        )
      case "/api/v1/albums":
        return .json(
          body:
            #"{"items":[{"id":"album-sea","title":"海边","artists":["测试歌手"],"track_count":8,"duration_ms":1440000,"cover_track_id":"track-sea"}],"total":1,"limit":24,"offset":0}"#
        )
      case "/api/v1/artists":
        return .json(
          body:
            #"{"items":[{"id":"artist-sea","name":"海边乐队","track_count":12,"album_count":2,"duration_ms":2160000,"cover_track_id":"track-sea"}],"total":1,"limit":24,"offset":0}"#
        )
      default:
        return .empty(status: 404)
      }
    }
    let client = WildstringClient(
      server: try ServerAddress(input: "music.example.com"),
      store: InMemorySessionStore(),
      configuration: StubURLProtocol.configuration()
    )
    let model = MacSearchModel(client: client)
    model.update(query: "海边")
    for _ in 0..<40 where model.loading {
      try await Task.sleep(for: .milliseconds(50))
    }

    #expect(!model.loading)
    #expect(model.tracks.map(\.id) == ["track-sea"])
    #expect(model.albums.map(\.id) == ["album-sea"])
    #expect(model.artists.map(\.id) == ["artist-sea"])
    #expect(model.error == nil)
    #expect(StubURLProtocol.requests.count == 3)
  }

  @Test func searchDropsResultsForSupersededQueries() async throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    let listener = try NWListener(using: parameters)
    let queue = DispatchQueue(label: "mac-search-fixture")
    listener.newConnectionHandler = { connection in
      connection.start(queue: queue)
      connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, _, _ in
        let request = String(data: data ?? Data(), encoding: .utf8) ?? ""
        let path = request.split(separator: " ").dropFirst().first.map(String.init) ?? ""
        let components = URLComponents(string: "http://fixture\(path)")
        let query =
          components?.queryItems?
          .first(where: { $0.name == "q" })?.value ?? ""
        if query == "旧" {
          Thread.sleep(forTimeInterval: 0.45)
        }
        let body: String
        switch components?.path {
        case "/api/v1/tracks":
          body =
            #"{"items":[{"id":"track-\#(query)","title":"\#(query)","artists":[],"duration_ms":60000,"has_cover":false}],"total":1,"limit":80,"offset":0}"#
        default:
          body = #"{"items":[],"total":0,"limit":24,"offset":0}"#
        }
        let bytes = Data(body.utf8)
        var response = Data(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
            .utf8
        )
        response.append(bytes)
        connection.send(
          content: response, completion: .contentProcessed { _ in connection.cancel() })
      }
    }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          listener.stateUpdateHandler = nil
          continuation.resume()
        case .failed(let error):
          listener.stateUpdateHandler = nil
          continuation.resume(throwing: error)
        default:
          break
        }
      }
      listener.start(queue: queue)
    }
    defer { listener.cancel() }
    let port = try #require(listener.port).rawValue
    let client = WildstringClient(
      server: try ServerAddress(
        input: "http://127.0.0.1:\(port)",
        allowsInsecureHTTP: true
      ),
      store: InMemorySessionStore()
    )
    let model = MacSearchModel(client: client)
    model.update(query: "旧")
    try await Task.sleep(for: .milliseconds(320))
    model.update(query: "新")
    for _ in 0..<40 where model.loading {
      try await Task.sleep(for: .milliseconds(50))
    }
    try await Task.sleep(for: .milliseconds(500))

    #expect(model.query == "新")
    #expect(model.tracks.map(\.title) == ["新"])
    #expect(!model.loading)
  }
}
