import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// MARK: - BrandLogo

struct BrandLogo: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawProgress = 0.0

    var body: some View {
        Group {
            if BrandSymbolAsset.isAvailable {
                Image("waynode.mark", variableValue: drawProgress)
                    .resizable()
                    .scaledToFit()
                    .symbolRenderingMode(.palette)
                    .symbolVariableValueMode(.draw)
                    .symbolEffect(.drawOn, isActive: !reduceMotion && drawProgress > 0)
                    .foregroundStyle(Color.accentColor, Color.blue.opacity(0.55), Color.white.opacity(0.9))
            } else {
                BrandLogoFallback()
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .onAppear {
            if reduceMotion {
                drawProgress = 1
            } else {
                drawProgress = 0
                withAnimation(.easeOut(duration: 1.1)) {
                    drawProgress = 1
                }
            }
        }
    }
}

private enum BrandSymbolAsset {
    static var isAvailable: Bool {
        #if canImport(UIKit)
        UIImage(named: "waynode.mark") != nil
        #elseif canImport(AppKit)
        NSImage(named: "waynode.mark") != nil
        #else
        false
        #endif
    }
}

private struct BrandLogoFallback: View {
    var body: some View {
        GeometryReader { proxy in
            let scale = min(proxy.size.width, proxy.size.height) / 64
            let nodes: [(CGFloat, CGFloat, CGFloat)] = [
                (11, 23, 4), (23, 30, 4), (32, 15, 4.5), (45, 27, 4),
                (55, 11, 4.5), (24, 50, 4.5), (32, 37, 4.5), (45, 50, 4.5),
            ]
            ZStack {
                Path { path in
                    path.move(to: CGPoint(x: 11 * scale, y: 23 * scale))
                    path.addLine(to: CGPoint(x: 24 * scale, y: 50 * scale))
                    path.addLine(to: CGPoint(x: 32 * scale, y: 15 * scale))
                    path.addLine(to: CGPoint(x: 45 * scale, y: 50 * scale))
                    path.addLine(to: CGPoint(x: 55 * scale, y: 11 * scale))
                    path.move(to: CGPoint(x: 11 * scale, y: 23 * scale))
                    path.addLine(to: CGPoint(x: 23 * scale, y: 30 * scale))
                    path.addLine(to: CGPoint(x: 32 * scale, y: 15 * scale))
                    path.addLine(to: CGPoint(x: 45 * scale, y: 27 * scale))
                    path.addLine(to: CGPoint(x: 55 * scale, y: 11 * scale))
                    path.move(to: CGPoint(x: 24 * scale, y: 50 * scale))
                    path.addLine(to: CGPoint(x: 32 * scale, y: 37 * scale))
                    path.addLine(to: CGPoint(x: 45 * scale, y: 50 * scale))
                }
                .stroke(
                    LinearGradient(colors: [.blue.opacity(0.55), .accentColor], startPoint: .topLeading, endPoint: .bottomTrailing),
                    style: StrokeStyle(lineWidth: 3.8 * scale, lineCap: .round, lineJoin: .round)
                )

                ForEach(nodes.indices, id: \.self) { index in
                    let node = nodes[index]
                    Circle()
                        .fill(.white.opacity(0.88))
                        .overlay(Circle().stroke(Color.accentColor, lineWidth: 1.4 * scale))
                        .frame(width: node.2 * 2 * scale, height: node.2 * 2 * scale)
                        .position(x: node.0 * scale, y: node.1 * scale)
                }
            }
        }
    }
}
