import SwiftUI
import WaynodeCore

enum GitRetryAction {
    case pull
    case push
}

struct GitInspector: View {
    let spaceId: String
    let fixtureSnapshot: GitSnapshot?
    @Environment(AppModel.self) var appModel
    @Environment(\.dismiss) private var dismiss
    @State var snapshot: GitSnapshot?
    @State var error: String?
    @State var isLoading: Bool = true
    @State var selectedFile: GitFile?
    @State var diffState: GitDiffState = .idle
    @State var showingCommitSheet = false
    @State var commitMessage = ""
    @State var selectedFiles: Set<String> = []
    @State var isCommitting = false
    @State var switchingBranch = false
    @State var commitError: String?
    @State var pendingBranch: String?
    @State private var showingBranchConfirm = false
    @State private var isBranchesExpanded = false
    @State var isPulling = false
    @State var isPushing = false
    @State var actionError: String?
    @State var retryAction: GitRetryAction?
    init(spaceId: String, fixtureSnapshot: GitSnapshot? = nil) {
        self.spaceId = spaceId
        self.fixtureSnapshot = fixtureSnapshot
    }
    var body: some View {
        NavigationStack {
            List {
                if isLoading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled).accessibilityLabel("Git error: \(error)")
                        Button("Retry") { Task { await loadSnapshot() } }.accessibilityIdentifier("git.retry")
                    }
                } else if let snapshot {
                    branchSection(snapshot)
                    statusSection(snapshot)
                    filesSection(snapshot)
                    commitsSection(snapshot)
                }
            }
            .navigationTitle("Git worktree")
            .platformInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .keyboardShortcut(.cancelAction).accessibilityIdentifier("git.done").accessibilityHint("Closes Git")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingCommitSheet = true
                    } label: {
                        Label("Commit", systemImage: "checkmark.circle")
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(
                        selectedFiles.isEmpty || isPulling || isPushing || switchingBranch
                            || snapshot?.files.contains(where: { $0.status == "conflict" }) == true
                    )
                    .keyboardShortcut(.defaultAction).accessibilityIdentifier("git.commit.open").accessibilityHint("Opens commit details for the selected files")
                }
            }
            .refreshable {
                await loadSnapshot()
            }
            .sheet(isPresented: $showingCommitSheet) {
                CommitSheet(
                    message: $commitMessage,
                    files: selectedFiles.sorted(),
                    isCommitting: $isCommitting,
                    error: $commitError
                ) {
                    Task { await commitSelected() }
                }
            }
            .sheet(item: $selectedFile) { file in
                FileDiffSheet(
                    filePath: file.path,
                    state: $diffState,
                    onLoad: { Task { await loadDiff(for: file.path) } }
                )
            }
            .alert(
                "Switch Branch?",
                isPresented: $showingBranchConfirm
            ) {
                if let branch = pendingBranch {
                    Button("Switch to \(branch)") {
                        Task { await switchBranch(branch) }
                    }.accessibilityIdentifier("git.branch.switch.confirm")
                    Button("Cancel", role: .cancel) {}.accessibilityIdentifier("git.branch.switch.cancel")
                }
            } message: {
                Text("Uncommitted changes will be carried to the new branch. This is safe but may cause merge conflicts if the target branch has diverged.")
            }
            .alert("Git action failed", isPresented: Binding(
                get: { actionError != nil },
                set: {
                    if !$0 {
                        actionError = nil
                        retryAction = nil
                    }
                }
            )) {
                if let retryAction {
                    Button("Retry") {
                        actionError = nil
                        Task {
                            switch retryAction {
                            case .pull: await pullChanges()
                            case .push: await pushChanges()
                            }
                        }
                    }
                    .accessibilityIdentifier("git.error.retry")
                }
                Button("Close", role: .cancel) {
                    actionError = nil
                    retryAction = nil
                }
                .accessibilityIdentifier("git.error.dismiss")
            } message: {
                Text(actionError ?? "").textSelection(.enabled).accessibilityLabel("Git action error: \(actionError ?? "")")
            }
            .task {
                await loadSnapshot()
            }
        }
        .macSheetFrame(minWidth: 660, idealWidth: 780, maxWidth: 960, minHeight: 600, idealHeight: 760)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("git.surface")
    }
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
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if let upstream = snap.upstream {
                            Text(upstream)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    Spacer()
                    syncBadge(snap)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("git.branch.summary")
                .accessibilityValue(snap.currentBranch)
                HStack(spacing: 10) {
                    Button {
                        Task { await pullChanges() }
                    } label: {
                        Label(snap.behind > 0 ? "Pull \(snap.behind)" : "Pull", systemImage: isPulling ? "arrow.triangle.2.circlepath" : "arrow.down")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(syncActionsBusy || pullBlockReason(snap) != nil)
                    .accessibilityIdentifier("git.pull")
                    .accessibilityHint(pullBlockReason(snap) ?? "Pulls remote changes into this worktree")

                    Button {
                        Task { await pushChanges() }
                    } label: {
                        Label(snap.ahead > 0 ? "Push \(snap.ahead)" : "Push", systemImage: isPushing ? "arrow.triangle.2.circlepath" : "arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(snap.ahead > 0 ? .accentColor : .secondary)
                    .disabled(syncActionsBusy || sharedSyncBlockReason(snap) != nil)
                    .accessibilityIdentifier("git.push")
                    .accessibilityHint(sharedSyncBlockReason(snap) ?? "Pushes local commits to the remote repository")
                }
                if let reason = pullBlockReason(snap) ?? sharedSyncBlockReason(snap) {
                    Label(reason, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("git.sync.blocked")
                }
            }
            .padding(.vertical, 4)

            DisclosureGroup(isExpanded: $isBranchesExpanded) {
                ForEach(snap.branches) { branch in
                    Button {
                        pendingBranch = branch.name
                        showingBranchConfirm = true
                    } label: {
                        HStack {
                            Image(systemName: branch.name == snap.currentBranch ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(branch.name == snap.currentBranch ? .green : .secondary)
                            Text(branch.name)
                                .lineLimit(1)
                                .truncationMode(.middle)
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
                    .disabled(branch.name == snap.currentBranch || switchingBranch || isPulling || isPushing).accessibilityIdentifier("git.branch.\(branch.name)")
                }
            } label: {
                Text("Branches")
                    .accessibilityIdentifier("git.branches.disclosure")
            }
        } header: {
            Text("Workspace")
        }
    }

    @ViewBuilder
    private func syncBadge(_ snap: GitSnapshot) -> some View {
        if snap.ahead > 0 && snap.behind > 0 {
            Label("Diverged", systemImage: "arrow.triangle.branch")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(.orange.opacity(0.12), in: Capsule())
        } else if snap.ahead == 0 && snap.behind == 0 {
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

    private func statusSection(_ snap: GitSnapshot) -> some View {
        Section {
            HStack {
                Image(systemName: snap.hasUncommittedChanges ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(snap.hasUncommittedChanges ? .orange : .green)
                Text(snap.hasUncommittedChanges ? "\(snap.files.count) uncommitted change\(snap.files.count == 1 ? "" : "s")" : "Working tree clean")
                    .font(.subheadline)
            }
            if snap.files.contains(where: { $0.status == "conflict" }) {
                Label("Resolve conflicted files before pulling, pushing, or committing.", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("git.conflicts")
            }
        } header: {
            Text("Status")
        }
    }

    private var syncActionsBusy: Bool {
        isPulling || isPushing || switchingBranch || isCommitting
    }

    private func sharedSyncBlockReason(_ snap: GitSnapshot) -> String? {
        if snap.detached { return "Check out a branch before synchronizing." }
        if snap.files.contains(where: { $0.status == "conflict" }) {
            return "Resolve conflicted files before synchronizing."
        }
        if snap.ahead > 0 && snap.behind > 0 {
            return "This branch has diverged. Choose a merge or rebase strategy outside this panel, then retry."
        }
        return nil
    }

    private func pullBlockReason(_ snap: GitSnapshot) -> String? {
        sharedSyncBlockReason(snap) ?? (snap.upstream == nil ? "Set an upstream by pushing this branch first." : nil)
    }

    private func filesSection(_ snap: GitSnapshot) -> some View {
        Group {
            if !snap.files.isEmpty {
                Section {
                    ForEach(snap.files) { file in
                        HStack(spacing: 10) {
                            Button {
                                toggleFileSelection(file.path)
                            } label: {
                                GitFileRow(file: file, isSelected: selectedFiles.contains(file.path))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(selectedFiles.contains(file.path) ? "Deselect" : "Select") \(file.path), status \(file.status)").accessibilityIdentifier("git.file.\(file.path).select")

                            Button {
                                diffState = .idle
                                selectedFile = file
                            } label: {
                                Label("Review diff", systemImage: "doc.text.magnifyingglass")
                                    .labelStyle(.iconOnly)
                            }
                            .buttonStyle(.borderless)
                            .help("Review diff").accessibilityIdentifier("git.file.\(file.path).review").accessibilityHint("Opens the changes in this file")
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
    }

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
                            .fixedSize(horizontal: false, vertical: true)
                        HStack {
                            Text(commit.hash.prefix(7))
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                            Text(commit.author)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Spacer()
                            Text(Format.compactRelative(fromISO: commit.date))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}
