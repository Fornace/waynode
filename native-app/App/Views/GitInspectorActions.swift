import SwiftUI
import WaynodeCore

extension GitInspector {
    func loadSnapshot() async {
        if let fixtureSnapshot {
            if snapshot == nil { snapshot = fixtureSnapshot }
            isLoading = false
            error = nil
            return
        }
        guard let api = appModel.currentAPI() else {
            error = "Server configuration is unavailable"
            isLoading = false
            return
        }
        isLoading = true
        error = nil
        do { applySnapshot(try await api.getGitSnapshot(spaceId)) }
        catch { self.error = error.localizedDescription }
        isLoading = false
    }

    func streamSnapshots() async {
        guard fixtureSnapshot == nil else { return }
        guard let api = appModel.currentAPI() else { return }

        do {
            let stream = await api.streamGitSnapshotEvents(spaceId: spaceId)
            for try await event in stream {
                guard !Task.isCancelled else { return }
                switch event {
                case .snapshot(let fresh):
                    applySnapshot(fresh)
                    error = nil
                    isLoading = false
                case .error(let message):
                    error = message
                    isLoading = false
                }
            }
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
            isLoading = false
        }
    }

    func discardChanges(in file: GitFile) async {
        pendingDiscard = nil
        guard discardEligible(file), !isDiscarding else { return }
        discardingPath = file.path
        defer { discardingPath = nil }

        if fixtureSnapshot != nil {
            snapshot?.files.removeAll { $0.path == file.path }
            snapshot?.hasUncommittedChanges = !(snapshot?.files.isEmpty ?? true)
            clearDiscardedFile(file.path)
            Haptics.success()
            return
        }
        guard let api = appModel.currentAPI() else {
            actionError = "Server configuration is unavailable"
            return
        }
        do {
            applySnapshot(try await api.discardTrackedFile(spaceId, path: file.path))
            Haptics.success()
        } catch {
            actionError = error.localizedDescription
            retryAction = nil
            Haptics.error()
        }
    }

    private func applySnapshot(_ fresh: GitSnapshot) {
        snapshot = fresh
        let paths = Set(fresh.files.map(\.path))
        selectedFiles.formIntersection(paths)
        if let file = selectedFile, !paths.contains(file.path) { clearDiscardedFile(file.path) }
        if let file = presentedDiffFile, !paths.contains(file.path) { clearDiscardedFile(file.path) }
    }

    private func clearDiscardedFile(_ path: String) {
        selectedFiles.remove(path)
        if selectedFile?.path == path { selectedFile = nil; diffState = .idle }
        if presentedDiffFile?.path == path { presentedDiffFile = nil; diffState = .idle }
    }

    func toggleFileSelection(_ path: String) {
        if selectedFiles.contains(path) { selectedFiles.remove(path) }
        else { selectedFiles.insert(path) }
    }

    func loadDiff(for path: String) async {
        diffState = .loading
        if fixtureSnapshot != nil {
            if CommandLine.arguments.contains("-ui-test-git-diff-error") {
                if !Task.isCancelled && isReviewing(path) {
                    diffState = .failed("The diff could not be loaded. Check the worktree connection and try again.")
                }
            } else {
                if !Task.isCancelled && isReviewing(path) {
                    diffState = .loaded("+ Added line in \(path)\n- Previous line\n context stays stable")
                }
            }
            return
        }
        guard let api = appModel.currentAPI() else {
            diffState = .failed("The diff is unavailable because the server is not configured.")
            return
        }
        do {
            let response = try await api.getGitDiff(spaceId, file: path)
            if !Task.isCancelled && isReviewing(path) { diffState = .loaded(response.diff) }
        } catch {
            if !Task.isCancelled && isReviewing(path) { diffState = .failed(error.localizedDescription) }
        }
    }

    private func isReviewing(_ path: String) -> Bool {
        selectedFile?.path == path || presentedDiffFile?.path == path
    }

    func commitSelected() async {
        isCommitting = true
        commitError = nil
        if fixtureSnapshot != nil {
            snapshot?.files.removeAll { selectedFiles.contains($0.path) }
            snapshot?.hasUncommittedChanges = !(snapshot?.files.isEmpty ?? true)
            snapshot?.ahead += 1
            selectedFiles.removeAll()
            commitMessage = ""
            showingCommitSheet = false
            isCommitting = false
            Haptics.success()
            return
        }
        guard let api = appModel.currentAPI() else {
            commitError = "Server configuration is unavailable"
            isCommitting = false
            return
        }
        do {
            _ = try await api.commitFiles(
                spaceId,
                message: commitMessage.trimmingCharacters(in: .whitespacesAndNewlines),
                files: selectedFiles.sorted()
            )
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

    func switchBranch(_ name: String) async {
        switchingBranch = true
        if fixtureSnapshot != nil {
            snapshot?.currentBranch = name
            snapshot?.upstream = "origin/\(name)"
            pendingBranch = nil
            switchingBranch = false
            Haptics.success()
            return
        }
        guard let api = appModel.currentAPI() else {
            error = "Server configuration is unavailable"
            switchingBranch = false
            return
        }
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

    func pullChanges() async { await synchronize(push: false) }
    func pushChanges() async { await synchronize(push: true) }

    private func synchronize(push: Bool) async {
        if fixtureSnapshot != nil {
            if CommandLine.arguments.contains("-ui-test-git-error") {
                actionError = "The remote could not be reached. Check your connection and try again."
                retryAction = push ? .push : .pull
            } else if push { snapshot?.ahead = 0 }
            return
        }
        guard let api = appModel.currentAPI() else {
            actionError = "Server configuration is unavailable"
            return
        }
        if push { isPushing = true } else { isPulling = true }
        do {
            if push { try await api.pushBranch(spaceId) }
            else { try await api.pullBranch(spaceId) }
            retryAction = nil
            Haptics.success()
            await loadSnapshot()
        } catch {
            actionError = error.localizedDescription
            retryAction = push ? .push : .pull
            Haptics.error()
        }
        if push { isPushing = false } else { isPulling = false }
    }
}

extension GitInspector {
    func discardEligible(_ file: GitFile) -> Bool {
        let status = file.status.lowercased()
        return ["modified", "deleted", "m", "d"].contains(status)
    }

    var discardConfirmationMessage: String {
        guard let file = pendingDiscard else { return "" }
        return "Restore \(file.path) to the last commit? Staged and unstaged changes will be permanently discarded. Added, renamed, conflicted, and untracked files are never affected by this action."
    }

    @ViewBuilder
    func syncBadge(_ snap: GitSnapshot) -> some View {
        if snap.ahead > 0 && snap.behind > 0 {
            Label("Diverged", systemImage: "arrow.triangle.branch")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
                .symbolEffect(.wiggle, value: snap.ahead + snap.behind)
                .contentTransition(.symbolEffect(.replace))
                .padding(.horizontal, 9).padding(.vertical, 6)
                .background(.orange.opacity(0.12), in: Capsule())
        } else if snap.ahead == 0 && snap.behind == 0 {
            Label("Synced", systemImage: "checkmark.circle.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.green)
                .symbolEffect(.bounce, value: snap.ahead + snap.behind)
                .contentTransition(.symbolEffect(.replace))
                .padding(.horizontal, 9).padding(.vertical, 6)
                .background(.green.opacity(0.12), in: Capsule())
        } else {
            VStack(alignment: .trailing, spacing: 3) {
                if snap.ahead > 0 {
                    Label("\(snap.ahead) ahead", systemImage: "arrow.up")
                        .foregroundStyle(.green)
                        .contentTransition(.numericText(value: Double(snap.ahead)))
                }
                if snap.behind > 0 {
                    Label("\(snap.behind) behind", systemImage: "arrow.down")
                        .foregroundStyle(.orange)
                        .contentTransition(.numericText(value: Double(snap.behind)))
                }
            }
            .font(.caption2.weight(.semibold))
        }
    }

    func statusSection(_ snap: GitSnapshot) -> some View {
        Section {
            HStack {
                Image(systemName: snap.hasUncommittedChanges ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(snap.hasUncommittedChanges ? .orange : .green)
                    .symbolEffect(.wiggle, value: snap.hasUncommittedChanges)
                    .contentTransition(.symbolEffect(.replace))
                Text(snap.hasUncommittedChanges ? "\(snap.files.count) uncommitted change\(snap.files.count == 1 ? "" : "s")" : "Working tree clean")
                    .font(.subheadline)
            }
            if snap.files.contains(where: { $0.status == "conflict" }) {
                Label("Resolve conflicted files before pulling, pushing, or committing.", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("git.conflicts")
            }
        } header: { Text("Status") }
    }

    var syncActionsBusy: Bool {
        isPulling || isPushing || switchingBranch || isCommitting || isDiscarding
    }

    var isDiscarding: Bool { discardingPath != nil }

    func sharedSyncBlockReason(_ snap: GitSnapshot) -> String? {
        if snap.detached { return "Check out a branch before synchronizing." }
        if snap.files.contains(where: { $0.status == "conflict" }) {
            return "Resolve conflicted files before synchronizing."
        }
        if snap.ahead > 0 && snap.behind > 0 {
            return "This branch has diverged. Choose a merge or rebase strategy outside this panel, then retry."
        }
        return nil
    }

    func pullBlockReason(_ snap: GitSnapshot) -> String? {
        sharedSyncBlockReason(snap) ?? (snap.upstream == nil ? "Set an upstream by pushing this branch first." : nil)
    }

    func commitsSection(_ snap: GitSnapshot) -> some View {
        Section("Recent Commits") {
            if snap.commits.isEmpty {
                Text("No commits yet").foregroundStyle(.secondary)
            } else {
                ForEach(snap.commits) { commit in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(commit.message)
                            .font(.caption).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        HStack {
                            Text(commit.hash.prefix(7))
                                .font(.caption2.monospaced()).foregroundStyle(.secondary)
                            Text(commit.author)
                                .font(.caption2).foregroundStyle(.secondary)
                                .lineLimit(1).truncationMode(.tail).help(commit.author)
                            Spacer()
                            Text(Format.compactRelative(fromISO: commit.date))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}
