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
    @State private var showingAccount = false
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
                    ContentUnavailableView {
                        ProgressView()
                    } description: {
                        Text("Loading worktrees…")
                    }
                    .listRowBackground(Color.clear)
                } else if let err = appModel.spacesError {
                    ContentUnavailableView {
                        Label("Couldn’t Load Worktrees", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(err)
                    } actions: {
                        Button("Retry") {
                            Task { await appModel.refreshAll() }
                        }
                    }
                    .listRowBackground(Color.clear)
                } else if !searchText.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                        .listRowBackground(Color.clear)
                } else {
                    ContentUnavailableView(
                        "No Worktrees",
                        systemImage: "folder.badge.plus",
                        description: Text("Clone a repository to create your first worktree.")
                    )
                    .listRowBackground(Color.clear)
                }
            } else {
                ForEach(filteredSpaces) { space in
                    NavigationLink(value: DeepLink.sessionsList(spaceId: space.id)) {
                        SpaceRow(space: space)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            spaceToDelete = space
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        .accessibilityIdentifier("worktree.\(space.id).delete")
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("worktrees.list")
        .navigationTitle("Worktrees")
        .navigationBarTitleDisplayMode(.inline)
        // Force search into a drawer below the title so it doesn't collide
        // with the Clone button in the navigation bar on iOS 26+.
        .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search worktrees")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    Haptics.light()
                    showingCloneSheet = true
                } label: {
                    Label("Clone Repository", systemImage: "plus")
                }
                .accessibilityIdentifier("worktree.clone")
                Button {
                    showingAccount = true
                } label: {
                    Label("Account", systemImage: "person.crop.circle")
                }
                .accessibilityIdentifier("account.open")
            }
        }
        .sheet(isPresented: $showingCloneSheet) {
            CloneSheet()
        }
        .sheet(isPresented: $showingAccount) {
            AccountSheetContainer()
        }
        .alert(
            "Delete Worktree?",
            isPresented: Binding(
                get: { spaceToDelete != nil },
                set: { if !$0 { spaceToDelete = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                if let space = spaceToDelete {
                    Haptics.rigid()
                    Task { await appModel.deleteSpace(space.id) }
                }
                spaceToDelete = nil
            }
            .accessibilityIdentifier("worktree.delete.confirm")
            Button("Cancel", role: .cancel) { spaceToDelete = nil }
                .accessibilityIdentifier("worktree.delete.cancel")
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
    var isSelected = false

    private var displayPath: String? {
        if let fn = space.repoFullName, !fn.isEmpty, !fn.contains("://") {
            return fn
        }
        let url = space.repoUrl.isEmpty ? (space.repoFullName ?? "") : space.repoUrl
        guard !url.isEmpty else { return nil }
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

    private var subtitle: String? {
        if let title = space.latestSessionTitle, !title.isEmpty { return title }
        return displayPath == space.repoName ? nil : displayPath
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.triangle.branch")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.tint)
                .frame(width: 32, height: 32)
                .background(.tint.opacity(0.11), in: RoundedRectangle(cornerRadius: 9))

            VStack(alignment: .leading, spacing: 3) {
                Text(space.repoName.isEmpty ? "Untitled" : space.repoName)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 4) {
                if !space.branch.isEmpty {
                    Text(space.branch)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let count = space.sessionCount, count > 0 {
                    Text("\(count) session\(count == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .background(isSelected ? Color.accentColor.opacity(0.13) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("worktree.row.\(space.id)")
        .accessibilityLabel(space.repoName.isEmpty ? "Untitled worktree" : space.repoName)
        .accessibilityValue(space.branch.isEmpty ? "No branch" : "Branch \(space.branch)")
        .accessibilityHint("Open sessions for this worktree")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .help(rowHelp)
    }

    private var rowHelp: String {
        let name = space.repoName.isEmpty ? "Untitled worktree" : space.repoName
        return [name, displayPath, space.branch.isEmpty ? nil : "Branch: \(space.branch)"]
            .compactMap { $0 }
            .joined(separator: "\n")
    }
}
