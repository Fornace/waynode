import SwiftUI
import WaynodeCore

// MARK: - HammersmithRunView
//
// Transcript row for a delegated Hammersmith job — a faithful port of the
// web HammersmithRunWidget: "H" mark, kicker, lifecycle title, counts,
// thin progress bar, error text, stop action, and a trusted monitor link.

struct HammersmithRunView: View {
    let run: HammersmithRun
    var onStop: ((String) -> Void)? = nil

    private var checked: Int { min(run.totalTasks, run.checkedTasks) }

    private var title: String {
        let verified = run.totalTasks > 0 && run.checkedTasks == run.totalTasks
            && run.passedTasks == run.totalTasks && run.failedTasks == 0
        switch run.lifecycle {
        case .running: return "Verified swarm running"
        case .finished: return verified ? "Verified" : "Finished without full verification"
        case .stopped: return "Run stopped"
        }
    }

    /// Accept only http/https URLs with no userinfo — anything else is not
    /// a link we are willing to render.
    private var trustedMonitorURL: URL? {
        guard let raw = run.monitorUrl,
              let components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              components.user == nil, components.password == nil,
              let url = components.url else { return nil }
        return url
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("H")
                    .font(.caption.bold().monospaced())
                    .foregroundStyle(.white)
                    .frame(width: 22, height: 22)
                    .background(Color.accentColor, in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Hammersmith")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    Text(title)
                        .font(.callout.weight(.semibold))
                }
                Spacer(minLength: 8)
                if run.lifecycle == .running, let onStop {
                    Button {
                        Haptics.light()
                        onStop(run.id)
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 24, height: 24)
                            .background(Color.red, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Stop Hammersmith run")
                    .accessibilityIdentifier("hammersmith.run.stop")
                    .frame(minWidth: 44, minHeight: 44)
                }
            }

            HStack(spacing: 6) {
                Text("\(checked)/\(run.totalTasks) checked")
                Text("·")
                Text("\(run.passedTasks) passed")
                Text("·")
                Text("\(run.failedTasks) failed")
                    .foregroundStyle(run.failedTasks > 0 ? Color.red : Color.primary)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("hammersmith.run.counts")

            ProgressView(value: Double(checked), total: Double(max(1, run.totalTasks)))
                .progressViewStyle(.linear)
                .accessibilityLabel("Verified swarm progress")
                .accessibilityValue("\(checked) of \(max(1, run.totalTasks)) checked")
                .accessibilityIdentifier("hammersmith.run.progress")

            if let error = run.error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("hammersmith.run.error")
            }

            if let monitor = trustedMonitorURL {
                Link(destination: monitor) {
                    Text("Open monitor →")
                        .font(.caption.weight(.medium))
                }
                .accessibilityLabel("Open full monitor, opens in a new window")
                .accessibilityIdentifier("hammersmith.run.monitor")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.secondary.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.accentColor.opacity(0.25))
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hammersmith.run.\(run.id)")
    }
}

// MARK: - UserBubbleShape
//
// Moved from ChatItemView.swift to keep that file under the repo's 400-line
// file gate. Renders the classic iMessage-style bubble with a flattened
// bottom-right corner.

struct UserBubbleShape: Shape {
    var radius: CGFloat = 18

    func path(in rect: CGRect) -> Path {
        let r = rect
        let tl = CGPoint(x: r.minX + radius, y: r.minY)
        let tr = CGPoint(x: r.maxX - radius, y: r.minY)
        let br = CGPoint(x: r.maxX, y: r.maxY)
        let bl = CGPoint(x: r.minX + radius, y: r.maxY)
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY + radius))
        p.addQuadCurve(to: tl, control: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: tr)
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.minY + radius),
                       control: CGPoint(x: r.maxX, y: r.minY))
        p.addLine(to: br)
        p.addLine(to: bl)
        p.addQuadCurve(to: CGPoint(x: r.minX, y: r.maxY - radius),
                       control: CGPoint(x: r.minX, y: r.maxY))
        p.closeSubpath()
        return p
    }
}
