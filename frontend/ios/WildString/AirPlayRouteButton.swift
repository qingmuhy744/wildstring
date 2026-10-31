import AVKit
import SwiftUI

struct AirPlayRouteButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let picker = AVRoutePickerView()
        picker.prioritizesVideoDevices = false
        picker.tintColor = .secondaryLabel
        return picker
    }

    func updateUIView(_ picker: AVRoutePickerView, context: Context) {}
}
