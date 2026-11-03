import AppKit
import CoreNetwork
import Foundation
import Observation

/// Polls the server health endpoint to surface reachability and round-trip
/// latency. Deliberately a heartbeat instead of a long-lived socket: the app
/// is request/response and streaming, and the probe doubles as connection
/// warm-up so the first playback skips cold DNS/TCP setup.
@Observable
@MainActor
final class MacConnectionMonitor {
    enum Status {
        case checking, online, slow, offline
    }

    private(set) var status: Status = .checking
    private(set) var latencyMs: Int?

    private let server: ServerAddress
    private let session: URLSession
    private var loop: Task<Void, Never>?
    private var failures = 0

    init(server: ServerAddress) {
        self.server = server
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8
        configuration.httpCookieStorage = nil
        self.session = URLSession(configuration: configuration)
    }

    var label: String {
        switch status {
        case .checking: return "连接中…"
        case .online: return "已连接 · \(latencyMs ?? 0)ms"
        case .slow: return "连接较慢 · \(latencyMs ?? 0)ms"
        case .offline: return "未连接"
        }
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.probe()
                let interval = NSApp.isActive ? 10 : 30
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    private func probe() async {
        let started = Date()
        do {
            let (_, response) = try await session.data(from: server.appending(path: "health"))
            guard let http = response as? HTTPURLResponse,
                (200..<300).contains(http.statusCode)
            else {
                recordFailure()
                return
            }
            failures = 0
            let ms = max(1, Int(Date().timeIntervalSince(started) * 1000))
            // Smooth spikes so a single slow request does not flip the color.
            latencyMs = latencyMs.map { ($0 * 2 + ms) / 3 } ?? ms
            status = (latencyMs ?? ms) >= 400 ? .slow : .online
        } catch {
            recordFailure()
        }
    }

    private func recordFailure() {
        failures += 1
        if failures >= 3 {
            status = .offline
            latencyMs = nil
        }
    }
}
