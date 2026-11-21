import SwiftUI

/// The button owns the action and accessibility label; all transport states occupy this one slot.
struct PlaybackTransportGlyph: View {
    var playing: Bool
    var buffering: Bool
    var size: CGFloat
    var foreground: Color = .primary
    var motionAllowed = true
    var reduceMotionOverride: Bool? = nil
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    private var reduceMotion: Bool { reduceMotionOverride ?? systemReduceMotion }
    private var phase: Int { buffering ? 2 : (playing ? 1 : 0) }

    var body: some View {
        ZStack {
            Image(systemName: "play.fill")
                .offset(x: size * 0.04)
                .opacity(phase == 0 ? 1 : 0)
                .scaleEffect(phase == 0 ? 1 : 0.88)
            Image(systemName: "pause.fill")
                .opacity(phase == 1 ? 1 : 0)
                .scaleEffect(phase == 1 ? 1 : 0.88)
            if buffering {
                Group {
                    if reduceMotion || !motionAllowed {
                        Circle().trim(from: 0, to: 0.75)
                            .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    } else {
                        #if os(macOS)
                        MacOnAccentProgress(side: size * 0.8)
                        #else
                        ProgressView().controlSize(.small).tint(foreground)
                        #endif
                    }
                }
                .frame(width: size * 0.8, height: size * 0.8)
                .transition(.opacity.combined(with: .scale(scale: 0.88)))
            }
        }
        .font(.system(size: size, weight: .semibold))
        .foregroundStyle(foreground)
        .frame(width: size, height: size)
        .animation(reduceMotion || !motionAllowed ? nil : .timingCurve(0.4, 0, 0.2, 1, duration: 0.24), value: phase)
        .transaction { if reduceMotion || !motionAllowed { $0.animation = nil; $0.disablesAnimations = true } }
        .accessibilityHidden(true)
    }
}
