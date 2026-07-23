import SwiftUI

struct ActivitySymbol: View {
    let systemImage: String
    var isActive = true
    var reduceMotion = false
    var size: CGFloat = 14
    var weight: Font.Weight = .semibold

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: size, weight: weight))
            .symbolRenderingMode(.hierarchical)
            .symbolEffect(.pulse, isActive: isActive && !reduceMotion)
    }
}

struct GitSyncActionLabel: View {
    let title: String
    let idleSystemImage: String
    let busyTitle: String
    let isBusy: Bool
    let reduceMotion: Bool

    var body: some View {
        Label {
            Text(isBusy ? busyTitle : title)
        } icon: {
            if isBusy {
                ActivitySymbol(
                    systemImage: "arrow.trianglehead.2.clockwise.rotate.90",
                    reduceMotion: reduceMotion,
                    size: 13
                )
            } else {
                Image(systemName: idleSystemImage)
            }
        }
        .symbolEffect(.bounce, value: isBusy)
    }
}
