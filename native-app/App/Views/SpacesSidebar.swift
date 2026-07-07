import SwiftUI
import WaynodeCore

// MARK: - SpacesScene
//
// The root of the Spaces tab. A list of cloned repos. Tapping a space
// pushes the SessionsList (sessions within that repo) onto the nav stack.
//
// Swipe-to-delete on spaces. "Clone Repo" button in the toolbar opens the
// CloneSheet. Search filters by repo name.

struct SpacesScene: View {
    @Environment(AppModel.self) private var appModel
    @State private var showingCloneSheet = false
    @State private var spaceToDelete: Space?
    @State private var searchText = ""

    private var filteredSpaces: [Space] {
        if searchText.isEmpty {
            return appModel.spaces
        }
        return appModel.spaces.filter { space in
            space.repoName.localizedCaseInsensitiveContains(searchText)
                || space.repoFullName?.localizedCaseInsensitiveContains(searchText) == true
        }
    }

    var body: some View {
        List {
            if filteredSpaces.isEmpty {
                if appModel.isLoadingSpaces {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if let err = appModel.spacesError {
                    ContentUnavailableView {
                        Label("Couldn't load spaces", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(err)
                    } actions: {
                        Button("Retry") {
                            Task { await appModel.refreshAll() }
                        }
                        .buttonStyle(.glass)
                    }
                    .listRowBackground(Color.clear)
                } else if !searchText.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                        .listRowBackground(Color.clear)
                } else {
                    ContentUnavailableView(
                        "No Spaces",
                        systemImage: "folder.badge.plus",
                        description: Text("Clone a repository to get started.")
                    )
                    .listRowBackground(Color.clear)
                }
            } else {
                ForEach(filteredSpaces) { space in
                    NavigationLink {
                        SessionsList(spaceId: space.id)
                    } label: {
                        SpaceRow(space: space)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            spaceToDelete = space
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .navigationTitle("Spaces")
        .searchable(text: $searchText, prompt: "Search spaces")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Haptics.light()
                    showingCloneSheet = true
                } label: {
                    Label("Clone Repo", systemImage: "plus")
                }
                .buttonStyle(.glass)
            }
        }
        .sheet(isPresented: $showingCloneSheet) {
            CloneSheet()
        }
        .confirmationDialog(
            "Delete Space?",
            isPresented: Binding(
                get: { spaceToDelete != nil },
                set: { if !$0 { spaceToDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let space = spaceToDelete {
                    Haptics.rigid()
                    Task { await appModel.deleteSpace(space.id) }
                }
                spaceToDelete = nil
            }
            Button("Cancel", role: .cancel) { spaceToDelete = nil }
        } message: {
            if let space = spaceToDelete {
                Text("This will remove \"\(space.repoName)\" and all its sessions. This cannot be undone.")
            } else {
                Text("This action cannot be undone.")
            }
        }
        .refreshable {
            await appModel.refreshSpaces()
        }
        .task {
            if appModel.spaces.isEmpty {
                await appModel.refreshSpaces()
            }
        }
    }
}

// MARK: - SpaceRow

struct SpaceRow: View {
    let space: Space

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "folder.fill")
                    .foregroundStyle(.tint)
                Text(space.repoName)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                if let count = space.sessionCount, count > 0 {
                    Text("\(count)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.12), in: Capsule())
                }
            }
            if !space.branch.isEmpty {
                Label(space.branch, systemImage: "arrow.triangle.branch")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - CloneSheet
//
// Self-contained clone flow: input form → live progress streaming →
// dismiss on completion or show error. The server creates the space row
// immediately and clones in the background; we subscribe to the
// clone-events SSE to show real-time `git clone --progress` output.

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
                case .input, .creating:
                    inputForm
                case .cloning:
                    progressView
                case .error(let message):
                    errorView(message)
                }
            }
            .navigationTitle(navTitle)
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isBusy)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isBusy ? "Hide" : "Cancel") {
                        dismiss()
                    }
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

    // MARK: - Input form

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
                        ForEach(appModel.orgs) { org in
                            Text(org.name).tag(org.id)
                        }
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
                .overlay {
                    if phase == .creating {
                        ProgressView()
                    }
                }
            }
        }
    }

    // MARK: - Progress view

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
                withAnimation(.easeOut(duration: 0.15)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .overlay(alignment: .bottom) {
                HStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Cloning repository…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding()
            }
        }
    }

    // MARK: - Error view

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

    // MARK: - Actions

    private func startClone() {
        let url = repoURL.trimmingCharacters(in: .whitespaces)
        let br = branch.trimmingCharacters(in: .whitespaces)
        guard !url.isEmpty else { return }

        phase = .creating
        progressLines = []

        Task {
            await performClone(url: url, branch: br.isEmpty ? nil : br)
        }
    }

    private func performClone(url: String, branch: String?) async {
        do {
            // Step 1: Create the space (server returns immediately, clones in background)
            let space = try await appModel.createSpace(
                repoUrl: url,
                branch: branch,
                orgId: orgId ?? appModel.orgs.first?.id
            )
            appModel.selectedSpaceId = space.id
            phase = .cloning

            // Step 2: Stream clone progress via SSE
            guard let api = appModel.currentAPI() else {
                // No API client — space was created, just dismiss
                Haptics.success()
                dismiss()
                return
            }

            let stream = await api.streamCloneProgress(spaceId: space.id)
            var gotTerminalEvent = false
            for try await event in stream {
                switch event {
                case .progress(let line):
                    if !line.isEmpty {
                        progressLines.append(line)
                    }
                case .done:
                    gotTerminalEvent = true
                    Haptics.success()
                    dismiss()
                case .error(let msg):
                    gotTerminalEvent = true
                    phase = .error(msg)
                    Haptics.error()
                }
            }

            // If the stream ended without a terminal event, the clone likely
            // finished before we subscribed (in-memory registry already cleaned
            // up after 5 min). The space exists and is usable — dismiss.
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
