import SwiftUI
import WaynodeCore
struct GitInspector: View {
    let spaceId: String
    let fixtureSnapshot: GitSnapshot?
    @Environment(AppModel.self) var appModel
    @Environment(\.dismiss) private var dismiss
    @State var snapshot: GitSnapshot?
    @State var error: String?
    @State var isLoading: Bool = true
    @State var selectedFile: GitFile?
    @State var diff: String?
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
            .navigationBarTitleDisplayMode(.inline)
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
                    .disabled(selectedFiles.isEmpty || isPulling || isPushing || switchingBranch)
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
                    diff: $diff,
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
                set: { if !$0 { actionError = nil } }
            )) {
                Button("OK", role: .cancel) {}.accessibilityIdentifier("git.error.dismiss")
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
                    .disabled(isPulling || isPushing || switchingBranch || isCommitting).accessibilityIdentifier("git.pull").accessibilityHint("Pulls remote changes into this worktree")

                    Button {
                        Task { await pushChanges() }
                    } label: {
                        Label(snap.ahead > 0 ? "Push \(snap.ahead)" : "Push", systemImage: isPushing ? "arrow.triangle.2.circlepath" : "arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(snap.ahead > 0 ? .accentColor : .secondary)
                    .disabled(isPulling || isPushing || switchingBranch || isCommitting).accessibilityIdentifier("git.push").accessibilityHint("Pushes local commits to the remote repository")
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
                                diff = nil
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
