import SwiftUI
import WaynodeCore

/// Clone input, live progress, and completion flow.
struct CloneSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(AppModel.self) private var appModel

    enum Phase: Equatable {
        case input
        case creating
        case cloning
        case error(String)
    }

    @State private var repoURL = ""
    @State private var branch = ""
    @State private var phase: Phase = .input
    @State private var progressLines: [String] = []

    private var isBusy: Bool {
        if case .creating = phase { return true }
        if case .cloning = phase { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .input, .creating: inputForm
                case .cloning: progressView
                case .error(let message): errorView(message)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("clone.surface")
            .navigationTitle(navTitle)
            .platformInlineNavigationTitle()
            .interactiveDismissDisabled(isBusy)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isBusy ? "Close" : "Cancel") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("clone.dismiss")
                        .accessibilityHint(isBusy ? "Closes this window while cloning continues" : "Closes without cloning")
                }
            }
        }
        .macSheetFrame(minWidth: 540, idealWidth: 660, minHeight: 520, idealHeight: 680)
    }

    private var navTitle: String {
        switch phase {
        case .input, .creating: "Clone Repository"
        case .cloning: "Cloning…"
        case .error: "Clone Failed"
        }
    }

    @ViewBuilder
    private var inputForm: some View {
        Form {
            Section {
                TextField("Repository URL", text: $repoURL, prompt: Text("https://github.com/org/repository.git"))
                    .platformURLTextInput()
                    .submitLabel(.done)
                    .accessibilityIdentifier("clone.repository.url")
                    .accessibilityHint("Enter an HTTPS or SSH Git repository address")
                TextField("Branch", text: $branch, prompt: Text("Optional"))
                    .platformCodeTextInput()
                    .accessibilityIdentifier("clone.branch")
                    .accessibilityHint("Optional; leave empty for the default branch")
            } header: {
                Label("Repository", systemImage: "shippingbox")
            } footer: {
                Text("Leave Branch empty to use the repository's default branch.")
            }
            if !appModel.orgs.isEmpty {
                Section {
                    Picker("Org", selection: Binding(
                        get: { appModel.activeOrgId ?? "" },
                        set: { appModel.selectOrganization($0) }
                    )) {
                        ForEach(appModel.orgs) { org in
                            Text("\(org.name) · \(roleLabel(org.myRole))").tag(org.id)
                        }
                    }
                    .accessibilityIdentifier("clone.organization")
                    if let org = appModel.activeOrg {
                        Label("New worktree: \(org.name) · \(roleLabel(org.myRole))", systemImage: "folder.badge.plus")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("clone.organization.summary")
                    }
                } header: {
                    Label("Organization", systemImage: "building.2")
                }
            } else {
                Section {
                    Label("No organization membership is available", systemImage: "person.2.slash")
                        .foregroundStyle(.secondary)
                } header: {
                    Label("Organization", systemImage: "building.2")
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Haptics.light()
                    startClone()
                } label: {
                    Label("Clone", systemImage: phase == .creating ? "square.and.arrow.down.fill" : "square.and.arrow.down")
                        .symbolEffect(.bounce, value: phase)
                }
                .disabled(repoURL.trimmingCharacters(in: .whitespaces).isEmpty || phase == .creating || appModel.activeOrg == nil)
                .buttonStyle(.glassProminent)
                .overlay { if phase == .creating { ProgressView() } }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("clone.start")
                .accessibilityHint("Creates a worktree in \(appModel.activeOrg?.name ?? "the selected organization")")
            }
        }
    }

    @ViewBuilder
    private var progressView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if progressLines.isEmpty {
                        Label("Connecting…", systemImage: "cable.connector")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .symbolEffect(.breathe, isActive: !reduceMotion)
                    } else {
                        ForEach(Array(progressLines.enumerated()), id: \.offset) { _, line in
                            Text(line)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .background(.regularMaterial)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Cloning repository")
            .accessibilityValue(progressLines.last ?? "Connecting")
            .accessibilityIdentifier("clone.progress")
            .onChange(of: progressLines.count) { _, _ in
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .overlay(alignment: .bottom) {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Label("Cloning repository…", systemImage: "arrow.down.doc")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .symbolEffect(.breathe, isActive: !reduceMotion)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding()
            }
        }
    }

    @ViewBuilder
    private func errorView(_ message: String) -> some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 38))
                    .foregroundStyle(.orange)
                    .symbolEffect(.wiggle, value: message)
                Text("Clone Failed")
                    .font(.title2.bold())
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityLabel("Clone error: \(message)")
                    .accessibilitySortPriority(2)
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Label("Close", systemImage: "xmark")
                    }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("clone.error.close")
                    Button {
                        phase = .input
                        progressLines = []
                    } label: {
                        Label("Try Again", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.glassProminent)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("clone.error.retry")
                }
            }
            .frame(maxWidth: 520)
            .padding(32)
        }
    }

    private func startClone() {
        let url = repoURL.trimmingCharacters(in: .whitespaces)
        let value = branch.trimmingCharacters(in: .whitespaces)
        guard !url.isEmpty else { return }
        phase = .creating
        progressLines = []
        Task { await performClone(url: url, branch: value.isEmpty ? nil : value) }
    }

    private func performClone(url: String, branch: String?) async {
        do {
            let space = try await appModel.createSpace(
                repoUrl: url,
                branch: branch,
                orgId: appModel.activeOrgId
            )
            appModel.selectedSpaceId = space.id
            phase = .cloning
            #if DEBUG
            if appModel.isUITestFixture {
                Haptics.success()
                dismiss()
                return
            }
            #endif
            guard let api = appModel.currentAPI() else {
                Haptics.success()
                dismiss()
                return
            }
            let stream = await api.streamCloneProgress(spaceId: space.id)
            var gotTerminalEvent = false
            for try await event in stream {
                switch event {
                case .progress(let line):
                    if !line.isEmpty { progressLines.append(line) }
                case .done:
                    gotTerminalEvent = true
                    Haptics.success()
                    dismiss()
                case .error(let message):
                    gotTerminalEvent = true
                    phase = .error(message)
                    Haptics.error()
                }
            }
            if !gotTerminalEvent {
                Haptics.success()
                dismiss()
            }
        } catch {
            phase = .error(error.localizedDescription)
            Haptics.error()
        }
    }

    private func roleLabel(_ role: String?) -> String {
        (role ?? "member").replacingOccurrences(of: "_", with: " ").capitalized
    }
}
