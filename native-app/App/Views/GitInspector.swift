import SwiftUI
import WaynodeCore
import OSLog

// MARK: - GitInspector
//
// Shows the git state of the selected space: current branch, ahead/behind,
// uncommitted changes, branches list, recent commits, and a diff viewer.
//
// All data comes from the server's git API (routes/git.js).

struct GitInspector: View {
    private let gitLog = Logger(subsystem: "com.waynode.app", category: "git-push")
    let spaceId: String
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var snapshot: GitSnapshot?
    @State private var error: String?
    @State private var isLoading: Bool = true
    @State private var selectedFile: GitFile?
    @State private var diff: String?
    @State private var showingCommitSheet = false
    @State private var commitMessage = ""
    @State private var selectedFiles: Set<String> = []
    @State private var isCommitting = false
    @State private var switchingBranch = false
    @State private var commitError: String?
    @State private var pendingBranch: String?
    @State private var showingBranchConfirm = false
    @State private var isBranchesExpanded = false
    @State private var isPulling = false
    @State private var isPushing = false
    @State private var actionError: String?

    var body: some View {
        NavigationStack {
            List {
                if isLoading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                        Button("Retry") { Task { await loadSnapshot() } }
                    }
                } else if let snapshot {
                    branchSection(snapshot)
                    statusSection(snapshot)
                    filesSection(snapshot)
                    commitsSection(snapshot)
                }
            }
            .navigationTitle("Git worktree")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingCommitSheet = true
                    } label: {
                        Label("Commit", systemImage: "checkmark.circle")
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(selectedFiles.isEmpty)
                }
            }
            .refreshable {
                await loadSnapshot()
            }
            .sheet(isPresented: $showingCommitSheet) {
                CommitSheet(
                    message: $commitMessage,
                    files: Array(selectedFiles),
                    isCommitting: $isCommitting,
                    error: $commitError
                ) {
                    Task { await commitSelected() }
                }
            }
            .confirmationDialog(
                "Switch Branch?",
                isPresented: $showingBranchConfirm,
                titleVisibility: .visible
            ) {
                if let branch = pendingBranch {
                    Button("Switch to \(branch)") {
                        Task { await switchBranch(branch) }
                    }
                    Button("Cancel", role: .cancel) {}
                }
            } message: {
                Text("Uncommitted changes will be carried to the new branch. This is safe but may cause merge conflicts if the target branch has diverged.")
            }
            .alert("Git action failed", isPresented: Binding(
                get: { actionError != nil },
                set: { if !$0 { actionError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(actionError ?? "")
            }
            .task {
                await loadSnapshot()
            }
        }
    }

    // MARK: - Branch section

    private func branchSection(_ snap: GitSnapshot) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.tint)
                        .frame(width: 38, height: 38)
                        .background(.tint.opacity(0.13), in: RoundedRectangle(cornerRadius: 11))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Git worktree")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(snap.currentBranch)
                            .font(.headline)
                        if let upstream = snap.upstream {
                            Text(upstream)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    syncBadge(snap)
                }

                // Sync actions remain separate, equal-sized targets. This makes the
                // current repo state readable first and the irreversible action clear.
                HStack(spacing: 10) {
                    Button {
                        Task { await pullChanges() }
                    } label: {
                        Label(snap.behind > 0 ? "Pull \(snap.behind)" : "Pull", systemImage: isPulling ? "arrow.triangle.2.circlepath" : "arrow.down")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(isPulling || isPushing)

                    Button {
                        Task { await pushChanges() }
                    } label: {
                        Label(snap.ahead > 0 ? "Push \(snap.ahead)" : "Push", systemImage: isPushing ? "arrow.triangle.2.circlepath" : "arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(snap.ahead > 0 ? .accentColor : .secondary)
                    .disabled(isPulling || isPushing)
                }
            }
            .padding(.vertical, 4)

            DisclosureGroup("Branches", isExpanded: $isBranchesExpanded) {
                ForEach(snap.branches) { branch in
                    Button {
                        pendingBranch = branch.name
                        showingBranchConfirm = true
                    } label: {
                        HStack {
                            Image(systemName: branch.name == snap.currentBranch ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(branch.name == snap.currentBranch ? .green : .secondary)
                            Text(branch.name)
                            if branch.isDefault {
                                Text("default")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(.thinMaterial, in: Capsule())
                            }
                        }
                    }
                    .disabled(branch.name == snap.currentBranch || switchingBranch)
                }
            }
        } header: {
            Text("Workspace")
        }
    }

    @ViewBuilder
    private func syncBadge(_ snap: GitSnapshot) -> some View {
        if snap.ahead == 0 && snap.behind == 0 {
            Label("Synced", systemImage: "checkmark.circle.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.green)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(.green.opacity(0.12), in: Capsule())
        } else {
            VStack(alignment: .trailing, spacing: 3) {
                if snap.ahead > 0 {
                    Label("\(snap.ahead) ahead", systemImage: "arrow.up")
                        .foregroundStyle(.green)
                }
                if snap.behind > 0 {
                    Label("\(snap.behind) behind", systemImage: "arrow.down")
                        .foregroundStyle(.orange)
                }
            }
            .font(.caption2.weight(.semibold))
        }
    }

    // MARK: - Status section

    private func statusSection(_ snap: GitSnapshot) -> some View {
        Section {
            HStack {
                Image(systemName: snap.hasUncommittedChanges ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(snap.hasUncommittedChanges ? .orange : .green)
                Text(snap.hasUncommittedChanges ? "\(snap.files.count) uncommitted change\(snap.files.count == 1 ? "" : "s")" : "Working tree clean")
                    .font(.subheadline)
            }
        } header: {
            Text("Status")
        }
    }

    // MARK: - Files section

    private func filesSection(_ snap: GitSnapshot) -> some View {
        Group {
            if !snap.files.isEmpty {
                Section {
                    ForEach(snap.files) { file in
                        Button {
                            selectedFile = file
                        } label: {
                            GitFileRow(file: file, isSelected: selectedFiles.contains(file.path))
                        }
                        .swipeActions(edge: .leading) {
                            Button {
                                toggleFileSelection(file.path)
                            } label: {
                                Label(selectedFiles.contains(file.path) ? "Deselect" : "Select", systemImage: selectedFiles.contains(file.path) ? "minus.circle" : "checkmark.circle")
                            }
                            .tint(.accentColor)
                        }
                    }
                } header: {
                    HStack {
                        Text("Changes")
                        Spacer()
                        Text("\(selectedFiles.count) selected")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .sheet(item: $selectedFile) { file in
            FileDiffSheet(
                filePath: file.path,
                diff: $diff,
                onLoad: { Task { await loadDiff(for: file.path) } }
            )
        }
    }

    // MARK: - Commits section

    private func commitsSection(_ snap: GitSnapshot) -> some View {
        Section("Recent Commits") {
            if snap.commits.isEmpty {
                Text("No commits yet")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(snap.commits) { commit in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(commit.message)
                            .font(.caption)
                            .lineLimit(2)
                        HStack {
                            Text(commit.hash.prefix(7))
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                            Text(commit.author)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text(Format.compactRelative(fromISO: commit.date))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Actions

    private func loadSnapshot() async {
        guard let api = appModel.currentAPI() else { return }
        isLoading = true
        error = nil
        do {
            snapshot = try await api.getGitSnapshot(spaceId)
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    private func toggleFileSelection(_ path: String) {
        if selectedFiles.contains(path) {
            selectedFiles.remove(path)
        } else {
            selectedFiles.insert(path)
        }
    }

    private func loadDiff(for path: String) async {
        guard let api = appModel.currentAPI() else { return }
        if let resp = try? await api.getGitDiff(spaceId, file: path) {
            diff = resp.diff
        }
    }

    private func commitSelected() async {
        guard let api = appModel.currentAPI() else { return }
        isCommitting = true
        commitError = nil
        do {
            _ = try await api.commitFiles(spaceId, message: commitMessage, files: Array(selectedFiles))
            selectedFiles.removeAll()
            commitMessage = ""
            Haptics.success()
            showingCommitSheet = false
            await loadSnapshot()
        } catch {
            commitError = error.localizedDescription
            Haptics.error()
        }
        isCommitting = false
    }

    private func switchBranch(_ name: String) async {
        guard let api = appModel.currentAPI() else { return }
        switchingBranch = true
        do {
            try await api.switchBranch(spaceId, branch: name, mode: "carry")
            Haptics.success()
            await loadSnapshot()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
        switchingBranch = false
    }

    private func pullChanges() async {
        guard let api = appModel.currentAPI() else { return }
        isPulling = true
        do {
            try await api.pullBranch(spaceId)
            Haptics.success()
            await loadSnapshot()
        } catch {
            actionError = error.localizedDescription
            Haptics.error()
        }
        isPulling = false
    }

    private func pushChanges() async {
        guard let api = appModel.currentAPI() else { return }
        isPushing = true
        gitLog.notice("Push requested for space \(spaceId, privacy: .public)")
        do {
            try await api.pushBranch(spaceId)
            gitLog.notice("Push succeeded for space \(spaceId, privacy: .public)")
            Haptics.success()
            await loadSnapshot()
        } catch {
            if let apiError = error as? APIClient.APIError {
                let operation = apiError.operationId ?? "none"
                gitLog.error("Push failed for space \(spaceId, privacy: .public), status=\(apiError.statusCode), operation=\(operation, privacy: .public), message=\(apiError.message, privacy: .public)")
            } else {
                gitLog.error("Push transport failure for space \(spaceId, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
            actionError = error.localizedDescription
            Haptics.error()
        }
        isPushing = false
    }
}

// MARK: - Git File Row

struct GitFileRow: View {
    let file: GitFile
    let isSelected: Bool

    var body: some View {
        HStack {
            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.tint)
            }
            Image(systemName: statusIcon)
                .foregroundStyle(statusColor)
                .font(.caption)
            Text(file.path)
                .font(.caption.monospaced())
                .lineLimit(1)
            Spacer()
        }
    }

    private var statusIcon: String {
        switch file.status.first?.uppercased() {
        case "M": return "pencil"
        case "A": return "plus"
        case "D": return "minus"
        case "R": return "arrow.right"
        case "U": return "questionmark"
        default: return "doc"
        }
    }

    private var statusColor: Color {
        switch file.status.first?.uppercased() {
        case "M": return .orange
        case "A": return .green
        case "D": return .red
        default: return .secondary
        }
    }
}

// MARK: - File Diff Sheet

struct FileDiffSheet: View {
    let filePath: String
    @Binding var diff: String?
    var onLoad: () async -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let diff {
                        ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                            DiffLineView(line: line)
                        }
                    } else {
                        ProgressView("Loading diff…")
                            .padding()
                    }
                }
                .padding(8)
            }
            .navigationTitle(filePath)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                if diff == nil { await onLoad() }
            }
        }
    }
}

struct DiffLineView: View {
    let line: String

    var body: some View {
        Text(line.isEmpty ? " " : line)
            .font(.system(.caption2, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(backgroundColor)
            .foregroundStyle(foregroundColor)
    }

    private var backgroundColor: Color {
        if line.hasPrefix("+") { return Color.green.opacity(0.15) }
        if line.hasPrefix("-") { return Color.red.opacity(0.15) }
        if line.hasPrefix("@@") { return Color.accentColor.opacity(0.1) }
        return Color.clear
    }

    private var foregroundColor: Color {
        if line.hasPrefix("+") { return .green }
        if line.hasPrefix("-") { return .red }
        if line.hasPrefix("@@") { return .accentColor }
        return .primary
    }
}

// MARK: - Commit Sheet

struct CommitSheet: View {
    @Binding var message: String
    let files: [String]
    @Binding var isCommitting: Bool
    @Binding var error: String?
    var onCommit: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Commit Message") {
                    TextField("Enter commit message…", text: $message, axis: .vertical)
                        .lineLimit(3...6)
                }
                Section("Files (\(files.count))") {
                    ForEach(files, id: \.self) { file in
                        Text(file)
                            .font(.caption.monospaced())
                    }
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
            }
            .navigationTitle("Commit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Commit") {
                        onCommit()
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCommitting)
                }
            }
        }
    }
}

// MARK: - Array enumeration helper
// (removed — using Array(…).enumerated()) directly)
