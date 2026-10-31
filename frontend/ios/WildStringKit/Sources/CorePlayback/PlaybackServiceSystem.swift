#if os(iOS) || os(macOS)
import AVFoundation
import Foundation
import MediaPlayer
#if os(iOS)
import UIKit
typealias NowPlayingImage = UIImage
#else
import AppKit
typealias NowPlayingImage = NSImage
#endif

extension PlaybackService {
    func configureSystemPlaybackIfNeeded() {
        guard !systemControlsConfigured else { return }
        systemControlsConfigured = true
        #if os(iOS)
            configureAudioSession()
        #endif
        configureRemoteCommands()
    }

    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.nextTrackCommand.isEnabled = true
        center.previousTrackCommand.isEnabled = true
        center.changePlaybackPositionCommand.isEnabled = true
        center.skipForwardCommand.isEnabled = true
        center.skipBackwardCommand.isEnabled = true
        center.skipForwardCommand.preferredIntervals = [NSNumber(value: 30)]
        center.skipBackwardCommand.preferredIntervals = [NSNumber(value: 15)]

        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.resume() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.pause() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.togglePlayPause() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.currentItem?.trackID.hasPrefix("podcast_ep_") == true {
                    self.seek(to: self.currentTime + 30)
                } else {
                    self.next()
                }
            }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.currentItem?.trackID.hasPrefix("podcast_ep_") == true {
                    self.seek(to: self.currentTime - 15)
                } else {
                    self.previous()
                }
            }
            return .success
        }
        center.skipForwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.seek(to: self.currentTime + 30)
            }
            return .success
        }
        center.skipBackwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.seek(to: self.currentTime - 15)
            }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            Task { @MainActor in self?.seek(to: event.positionTime) }
            return .success
        }
    }

    #if os(iOS)
        private func configureAudioSession() {
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playback, mode: .default)
            try? session.setActive(true)

            let interruptionToken = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: session,
                queue: .main
            ) { [weak self] notification in
                let typeRaw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
                let optionsRaw =
                    notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                Task { @MainActor in
                    self?.handleInterruption(typeRaw: typeRaw, optionsRaw: optionsRaw)
                }
            }
            systemObserverTokens.append(interruptionToken)

            let routeToken = NotificationCenter.default.addObserver(
                forName: AVAudioSession.routeChangeNotification,
                object: session,
                queue: .main
            ) { [weak self] notification in
                let reasonRaw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
                Task { @MainActor in
                    self?.handleRouteChange(reasonRaw: reasonRaw)
                }
            }
            systemObserverTokens.append(routeToken)
        }

        private func handleInterruption(typeRaw: UInt?, optionsRaw: UInt) {
            guard let typeRaw, let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else {
                return
            }
            switch type {
            case .began:
                player.pause()
            case .ended:
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
                if options.contains(.shouldResume) {
                    resume()
                }
            @unknown default:
                break
            }
        }

        private func handleRouteChange(reasonRaw: UInt?) {
            guard let reasonRaw,
                AVAudioSession.RouteChangeReason(rawValue: reasonRaw) == .oldDeviceUnavailable
            else { return }
            pause()
        }
    #endif

    func updateSystemNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        guard let item = currentItem else {
            center.nowPlayingInfo = nil
            center.playbackState = .stopped
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.title,
            MPMediaItemPropertyArtist: item.artist,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
        ]
        if let album = item.album, !album.isEmpty {
            info[MPMediaItemPropertyAlbumTitle] = album
        }
        if duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        if !item.hasCover {
            info.removeValue(forKey: MPMediaItemPropertyArtwork)
        }
        center.nowPlayingInfo = info
        center.playbackState = isPlaying ? .playing : .paused
        loadArtworkIfNeeded(for: item)
    }

    func clearSystemNowPlaying() {
        nowPlayingArtworkTask?.cancel()
        nowPlayingArtworkTask = nil
        nowPlayingArtworkTrackID = nil
        let center = MPNowPlayingInfoCenter.default()
        center.nowPlayingInfo = nil
        center.playbackState = .stopped
    }

    private func loadArtworkIfNeeded(for item: PlaybackService.Item) {
        guard item.hasCover else { return }
        let trackID = item.trackID
        if let image = NowPlayingArtworkCache.shared.image(for: trackID) {
            applyArtwork(image, to: trackID)
            return
        }
        if nowPlayingArtworkTrackID == trackID, nowPlayingArtworkTask != nil { return }
        nowPlayingArtworkTask?.cancel()
        nowPlayingArtworkTrackID = trackID
        let header = clientHeaderName
        nowPlayingArtworkTask = Task { [weak self] in
            guard let self else { return }
            defer { self.nowPlayingArtworkTask = nil }
            var request = URLRequest(url: server.appending(path: "api/v1/tracks/\(trackID)/cover"))
            request.setValue(header, forHTTPHeaderField: "X-Wildstring-Client")
            if let cookie = await cookieHeader() {
                request.setValue(cookie, forHTTPHeaderField: "Cookie")
            }
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                (response as? HTTPURLResponse)?.statusCode == 200,
                let image = NowPlayingImage(data: data),
                !Task.isCancelled
            else { return }
            NowPlayingArtworkCache.shared.store(image, for: trackID)
            applyArtwork(image, to: trackID)
        }
    }

    private func applyArtwork(_ image: NowPlayingImage, to trackID: String) {
        guard currentItem?.trackID == trackID else { return }
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in
            image
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

private final class NowPlayingArtworkCache: @unchecked Sendable {
    static let shared = NowPlayingArtworkCache()
    private let cache = NSCache<NSString, NowPlayingImage>()

    func image(for trackID: String) -> NowPlayingImage? {
        cache.object(forKey: trackID as NSString)
    }

    func store(_ image: NowPlayingImage, for trackID: String) {
        cache.setObject(image, forKey: trackID as NSString)
    }
}
#endif
