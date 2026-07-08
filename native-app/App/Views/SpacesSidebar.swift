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
                    NavigationLink(value: DeepLink.sessionsList(spaceId: space.id)) {
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
        // Force search into a drawer below the title so it doesn't collide
        // with the Clone button in the navigation bar on iOS 26+.
        .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search spaces")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Haptics.light()
                    showingCloneSheet = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .symbolRenderingMode(.hierarchical)
                }
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

    /// Derive a human-readable repo path from repoFullName or repoUrl.
    /// Server stores repo_full_name as the full URL in some cases; we
    /// extract the `owner/repo` portion for display.
    private var displayPath: String? {
        // Prefer repoFullName if it looks like an org/repo path (not a URL)
        if let fn = space.repoFullName, !fn.isEmpty, !fn.contains("://") {
            return fn
        }
        // Extract from URL: https://github.com/Fornace/waynode.git → Fornace/waynode
        let url = space.repoUrl.isEmpty ? (space.repoFullName ?? "") : space.repoUrl
        guard !url.isEmpty else { return nil }
        // Strip .git suffix and protocol, take last two path components
        var cleaned = url
        if cleaned.hasSuffix(".git") { cleaned.removeLast(4) }
        if let schemeRange = cleaned.range(of: "://") {
            cleaned = String(cleaned[schemeRange.upperBound...])
        }
        let parts = cleaned.split(separator: "/").filter { !$0.isEmpty }
        if parts.count >= 2 {
            return "\(parts[parts.count - 2])/\(parts[parts.count - 1])"
        }
        return nil
    }

    /// Short date+time label so clones of the same repo are distinguishable.
    /// Uses absolute time ("Jun 24, 5:43 PM") rather than relative because
    /// 15 clones created the same day all collapse to "1 wk ago".
    private var dateLabel: String? {
        guard !space.createdAt.isEmpty else { return nil }
        let date = parseDate(space.createdAt)
        guard let date else { return nil }
        let df = DateFormatter()
        // If older than a week, show month + day + time; otherwise full date.
        df.locale = Locale.autoupdatingCurrent
        df.setLocalizedDateFormatFromTemplate("MMMd HHmm")
        return df.string(from: date)
    }

    private func parseDate(_ s: String) -> Date? {
        // Server format: "2026-06-24 17:43:07" (SQLite datetime)
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.dateFormat = "yyyy-MM-dd HH:mm:ss"
        if let d = df.date(from: s) { return d }
        // Fallback: ISO 8601
        let iso = ISO8601DateFormatter()
        return iso.date(from: s)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Title row: repo name + session count badge
            HStack(spacing: 6) {
                Image(systemName: "book.closed.fill")
                    .font(.subheadline)
                    .foregroundStyle(.tint)
                Text(space.repoName.isEmpty ? "Untitled" : space.repoName)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let count = space.sessionCount, count > 0 {
                    Text("\(count)")
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.15), in: Capsule())
                }
            }
            // Latest session preview — the most useful distinguishing info.
            // Shows what was last worked on in this workspace.
            if let title = space.latestSessionTitle, !title.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "bubble.left.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(.tint)
                    Text(title)
                        .font(.subheadline)
                        .foregroundStyle(.primary.opacity(0.85))
                        .lineLimit(1)
                }
            }
            // Metadata row: owner/repo (if different) + timestamp + branch
            HStack(spacing: 6) {
                if let path = displayPath, path != space.repoName {
                    Text(path)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text("·")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                if let date = dateLabel {
                    Text(date)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                if !space.branch.isEmpty && space.branch != "main" {
                    Text("·")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Label(space.branch, systemImage: "arrow.triangle.branch")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
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
