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
        do { snapshot = try await api.getGitSnapshot(spaceId) }
        catch { self.error = error.localizedDescription }
        isLoading = false
    }

    func toggleFileSelection(_ path: String) {
        if selectedFiles.contains(path) { selectedFiles.remove(path) }
        else { selectedFiles.insert(path) }
    }

    func loadDiff(for path: String) async {
        diffState = .loading
        if fixtureSnapshot != nil {
            if CommandLine.arguments.contains("-ui-test-git-diff-error") {
                diffState = .failed("The diff could not be loaded. Check the worktree connection and try again.")
            } else {
                diffState = .loaded("+ Added line in \(path)\n- Previous line\n context stays stable")
            }
            return
        }
        guard let api = appModel.currentAPI() else {
            diffState = .failed("The diff is unavailable because the server is not configured.")
            return
        }
        do {
            let response = try await api.getGitDiff(spaceId, file: path)
            diffState = .loaded(response.diff)
        } catch {
            diffState = .failed(error.localizedDescription)
        }
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
