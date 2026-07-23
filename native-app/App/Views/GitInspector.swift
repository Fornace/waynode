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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State var snapshot: GitSnapshot?
    @State var error: String?
    @State var isLoading: Bool = true
    @State var selectedFile: GitFile?
    @State var presentedDiffFile: GitFile?
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
    @State var pendingDiscard: GitFile?
    @State var discardingPath: String?
    init(spaceId: String, fixtureSnapshot: GitSnapshot? = nil) {
        self.spaceId = spaceId
        self.fixtureSnapshot = fixtureSnapshot
    }
    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                let usesWideLayout = geometry.size.width >= wideLayoutThreshold
                Group {
                    if usesWideLayout {
                        HStack(spacing: 0) {
                            worktreeList(usesWideLayout: true)
                                .frame(minWidth: 340, idealWidth: 400, maxWidth: 460)
                            Divider()
                            GitInlineDiffPane(
                                file: selectedFile,
                                state: $diffState,
                                onLoad: { file in await loadDiff(for: file.path) }
                            )
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                        .accessibilityIdentifier("git.layout.wide")
                    } else {
                        worktreeList(usesWideLayout: false)
                            .accessibilityIdentifier("git.layout.compact")
                    }
                }
            }
            .navigationTitle("Git worktree")
            .platformInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .disabled(isDiscarding)
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
                            || isDiscarding
                            || snapshot?.files.contains(where: { $0.status == "conflict" }) == true
                    )
                    .keyboardShortcut(.defaultAction).accessibilityIdentifier("git.commit.open").accessibilityHint("Opens commit details for the selected files")
                }
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
            .sheet(item: $presentedDiffFile) { file in
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
            .alert("Discard Changes?", isPresented: Binding(
                get: { pendingDiscard != nil },
                set: { if !$0 { pendingDiscard = nil } }
            )) {
                Button("Discard Changes", role: .destructive) {
                    if let file = pendingDiscard { Task { await discardChanges(in: file) } }
                }
                .accessibilityIdentifier("git.discard.confirm")
                Button("Keep Changes", role: .cancel) { pendingDiscard = nil }
                    .accessibilityIdentifier("git.discard.cancel")
            } message: {
                Text(discardConfirmationMessage)
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
                await streamSnapshots()
            }
        }
        .interactiveDismissDisabled(isDiscarding)
        .macSheetFrame(minWidth: 660, idealWidth: 1_020, maxWidth: 1_280, minHeight: 600, idealHeight: 760)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("git.surface")
    }

    private var wideLayoutThreshold: CGFloat {
        #if targetEnvironment(macCatalyst) || os(macOS)
        // The Mac presentation has a guaranteed 660pt minimum; always use its
        // review-oriented two-pane layout instead of falling back to a modal.
        0
        #else
        820
        #endif
    }

    private func worktreeList(usesWideLayout: Bool) -> some View {
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
                filesSection(snapshot, usesWideLayout: usesWideLayout)
                commitsSection(snapshot)
            }
        }
        .refreshable { await loadSnapshot() }
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
                            .help(snap.currentBranch)
                        if let upstream = snap.upstream {
                            Text(upstream)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .help(upstream)
                        }
                    }
                    Spacer()
                    syncBadge(snap)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("git.branch.summary")
                .accessibilityValue(snap.currentBranch)
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 132), spacing: 10)],
                    spacing: 10
                ) {
                    Button {
                        Task { await pullChanges() }
                    } label: {
                        GitSyncActionLabel(
                            title: snap.behind > 0 ? "Pull \(snap.behind)" : "Pull",
                            idleSystemImage: "arrow.down",
                            busyTitle: "Pulling",
                            isBusy: isPulling,
                            reduceMotion: reduceMotion
                        )
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(syncActionsBusy || pullBlockReason(snap) != nil)
                    .accessibilityIdentifier("git.pull")
                    .accessibilityHint(pullBlockReason(snap) ?? "Pulls remote changes into this worktree")

                    Button {
                        Task { await pushChanges() }
                    } label: {
                        GitSyncActionLabel(
                            title: snap.ahead > 0 ? "Push \(snap.ahead)" : "Push",
                            idleSystemImage: "arrow.up",
                            busyTitle: "Pushing",
                            isBusy: isPushing,
                            reduceMotion: reduceMotion
                        )
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
                    .disabled(branch.name == snap.currentBranch || syncActionsBusy)
                    .accessibilityIdentifier("git.branch.\(branch.name)")
                }
            } label: {
                Text("Branches")
                    .accessibilityIdentifier("git.branches.disclosure")
            }
        } header: {
            Text("Workspace")
        }
    }

    private func filesSection(_ snap: GitSnapshot, usesWideLayout: Bool) -> some View {
        Group {
            if !snap.files.isEmpty {
                Section {
                    ForEach(snap.files) { file in
                        HStack(spacing: 10) {
                            Button {
                                toggleFileSelection(file.path)
                            } label: {
                                GitFileRow(
                                    file: file,
                                    isSelected: selectedFiles.contains(file.path),
                                    allowsWrapping: usesWideLayout
                                )
                            }
                            .buttonStyle(.plain)
                            .disabled(isDiscarding)
                            .accessibilityLabel("\(selectedFiles.contains(file.path) ? "Deselect" : "Select") \(file.path), status \(file.status)").accessibilityIdentifier("git.file.\(file.path).select")

                            Button {
                                diffState = .idle
                                if usesWideLayout { selectedFile = file }
                                else { presentedDiffFile = file }
                            } label: {
                                if usesWideLayout {
                                    Label("Review", systemImage: "doc.text.magnifyingglass")
                                } else {
                                    Label("Review diff", systemImage: "doc.text.magnifyingglass")
                                        .labelStyle(.iconOnly)
                                }
                            }
                            .buttonStyle(.borderless)
                            .disabled(isDiscarding)
                            .help("Review diff").accessibilityIdentifier("git.file.\(file.path).review").accessibilityHint("Opens the changes in this file")

                            if discardEligible(file) {
                                Button(role: .destructive) { pendingDiscard = file } label: {
                                    HStack(spacing: 5) {
                                        if discardingPath == file.path {
                                            ProgressView().controlSize(.small)
                                        } else {
                                            Image(systemName: "arrow.uturn.backward")
                                            if usesWideLayout { Text("Discard") }
                                        }
                                    }
                                }
                                .buttonStyle(.borderless)
                                .disabled(syncActionsBusy || isDiscarding)
                                .help("Discard changes")
                                .accessibilityIdentifier("git.file.\(file.path).discard")
                                .accessibilityHint("Asks before restoring the committed version")
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text("Changes")
                        Spacer()
                        Text("\(selectedFiles.count) selected")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .contentTransition(.numericText(value: Double(selectedFiles.count)))
                    }
                }
            }
        }
    }

}
