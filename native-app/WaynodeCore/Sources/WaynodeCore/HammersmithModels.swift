import Foundation
#if canImport(SwiftUI)
import SwiftUI
#endif

// MARK: - Hammersmith models
//
// Mirror of the web client's hammersmith capability + public job shapes.
// Decoding is lenient (Models.swift style): missing keys fall back to
// defaults so a server version drift never crashes the client.

public struct HammersmithCapability: Codable, Hashable, Sendable {
    public var available: Bool
    public var installed: Bool?
    public var dashboardUrl: String?
    public var version: String?
    public var state: String?
    public var hosted: HostedScope?

    public struct HostedScope: Codable, Hashable, Sendable {
        public var billingRequired: Bool?
        public var entitled: Bool?
        public init(billingRequired: Bool? = nil, entitled: Bool? = nil) {
            self.billingRequired = billingRequired
            self.entitled = entitled
        }
    }

    enum CodingKeys: String, CodingKey {
        case available, installed, version, state, hosted
        case dashboardUrl = "dashboardUrl"
    }

    public init(
        available: Bool = false, installed: Bool? = nil, dashboardUrl: String? = nil,
        version: String? = nil, state: String? = nil, hosted: HostedScope? = nil
    ) {
        self.available = available
        self.installed = installed
        self.dashboardUrl = dashboardUrl
        self.version = version
        self.state = state
        self.hosted = hosted
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        installed = try c.decodeIfPresent(Bool.self, forKey: .installed)
        dashboardUrl = try c.decodeIfPresent(String.self, forKey: .dashboardUrl)
        version = try c.decodeIfPresent(String.self, forKey: .version)
        state = try c.decodeIfPresent(String.self, forKey: .state)
        hosted = try c.decodeIfPresent(HostedScope.self, forKey: .hosted)
    }
}

public enum HammersmithRunLifecycle: String, Codable, Sendable, Hashable {
    case running, finished, stopped
}

public struct HammersmithRun: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var submissionId: String?
    public var runId: String?
    public var sessionId: String?
    public var spaceId: String?
    public var description: String
    public var lifecycle: HammersmithRunLifecycle
    public var totalTasks: Int
    public var checkedTasks: Int
    public var passedTasks: Int
    public var failedTasks: Int
    public var monitorUrl: String?
    public var error: String?
    public var createdAt: String?
    public var updatedAt: String?
    public var finishedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, description, lifecycle, error
        case submissionId = "submissionId"
        case runId = "runId"
        case sessionId = "sessionId"
        case spaceId = "spaceId"
        case totalTasks = "totalTasks"
        case checkedTasks = "checkedTasks"
        case passedTasks = "passedTasks"
        case failedTasks = "failedTasks"
        case monitorUrl = "monitorUrl"
        case createdAt = "createdAt"
        case updatedAt = "updatedAt"
        case finishedAt = "finishedAt"
    }

    public init(
        id: String, submissionId: String? = nil, runId: String? = nil,
        sessionId: String? = nil, spaceId: String? = nil, description: String = "",
        lifecycle: HammersmithRunLifecycle = .running,
        totalTasks: Int = 0, checkedTasks: Int = 0, passedTasks: Int = 0, failedTasks: Int = 0,
        monitorUrl: String? = nil, error: String? = nil,
        createdAt: String? = nil, updatedAt: String? = nil, finishedAt: String? = nil
    ) {
        self.id = id
        self.submissionId = submissionId
        self.runId = runId
        self.sessionId = sessionId
        self.spaceId = spaceId
        self.description = description
        self.lifecycle = lifecycle
        self.totalTasks = totalTasks
        self.checkedTasks = checkedTasks
        self.passedTasks = passedTasks
        self.failedTasks = failedTasks
        self.monitorUrl = monitorUrl
        self.error = error
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.finishedAt = finishedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        submissionId = try c.decodeIfPresent(String.self, forKey: .submissionId)
        runId = try c.decodeIfPresent(String.self, forKey: .runId)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        spaceId = try c.decodeIfPresent(String.self, forKey: .spaceId)
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        let raw = try c.decodeIfPresent(String.self, forKey: .lifecycle)
        lifecycle = raw.flatMap(HammersmithRunLifecycle.init(rawValue:)) ?? .running
        totalTasks = try c.decodeIfPresent(Int.self, forKey: .totalTasks) ?? 0
        checkedTasks = try c.decodeIfPresent(Int.self, forKey: .checkedTasks) ?? 0
        passedTasks = try c.decodeIfPresent(Int.self, forKey: .passedTasks) ?? 0
        failedTasks = try c.decodeIfPresent(Int.self, forKey: .failedTasks) ?? 0
        monitorUrl = try c.decodeIfPresent(String.self, forKey: .monitorUrl)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        finishedAt = try c.decodeIfPresent(String.self, forKey: .finishedAt)
    }
}

// MARK: - HammersmithRunView / UserBubbleShape (compiled app views)
//
// These SwiftUI views live in the package because the checked-in Xcode
// project is generated from project.yml with an explicit file list that this
// change must not edit, while SwiftPM globs Sources/ at build time.
// App/Views/HammersmithRunView.swift holds the app-layer twin that takes
// over the next time the project is regenerated with xcodegen.

#if canImport(SwiftUI)
public struct HammersmithRunView: View {
    public let run: HammersmithRun
    public var onStop: ((String) -> Void)?

    public init(run: HammersmithRun, onStop: ((String) -> Void)? = nil) {
        self.run = run
        self.onStop = onStop
    }

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

    public var body: some View {
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

/// Rounded-rect bubble with a slightly flattened bottom-right corner — the
/// classic iMessage "tail" cue without drawing a full tail. Moved out of
/// ChatItemView.swift for the 400-line file gate.
public struct UserBubbleShape: Shape {
    public var radius: CGFloat
    public init(radius: CGFloat = 18) { self.radius = radius }

    public func path(in rect: CGRect) -> Path {
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
#endif
