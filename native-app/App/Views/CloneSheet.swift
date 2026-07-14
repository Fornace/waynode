import SwiftUI
import WaynodeCore

/// Clone input, live progress, and completion flow.
struct CloneSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var appModel

    enum Phase: Equatable {
        case input
        case creating
        case cloning
        case error(String)
    }

    @State private var repoURL = ""
    @State private var branch = ""
    @State private var orgId: String?
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
            .navigationTitle(navTitle)
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isBusy)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isBusy ? "Hide" : "Cancel") { dismiss() }
                }
            }
        }
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
            Section("Repository") {
                TextField("https://github.com/user/repo.git", text: $repoURL)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.done)
                TextField("Branch (optional, defaults to default branch)", text: $branch)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }
            if appModel.orgs.count > 1 {
                Section("Organization") {
                    Picker("Org", selection: Binding(
                        get: { orgId ?? appModel.orgs.first?.id ?? "" },
                        set: { orgId = $0.isEmpty ? nil : $0 }
                    )) {
                        ForEach(appModel.orgs) { org in Text(org.name).tag(org.id) }
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Clone") {
                    Haptics.light()
                    startClone()
                }
                .disabled(repoURL.trimmingCharacters(in: .whitespaces).isEmpty || phase == .creating)
                .buttonStyle(.glassProminent)
                .overlay { if phase == .creating { ProgressView() } }
            }
        }
    }

    @ViewBuilder
    private var progressView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if progressLines.isEmpty {
                        Text("Connecting…")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
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
            .onChange(of: progressLines.count) { _, _ in
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .overlay(alignment: .bottom) {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Cloning repository…").font(.subheadline).foregroundStyle(.secondary)
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
        ContentUnavailableView {
            Label("Clone Failed", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try Again") {
                phase = .input
                progressLines = []
            }
            .buttonStyle(.glassProminent)
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
                orgId: orgId ?? appModel.orgs.first?.id
            )
            appModel.selectedSpaceId = space.id
            phase = .cloning
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
}
