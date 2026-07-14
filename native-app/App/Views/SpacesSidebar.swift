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
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
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
        .navigationTitle("Workspaces")
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
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "arrow.triangle.branch")
                .font(.body.weight(.semibold))
                .foregroundStyle(.tint)
                .frame(width: 40, height: 40)
                .background(.tint.opacity(0.13), in: RoundedRectangle(cornerRadius: 12))

            VStack(alignment: .leading, spacing: 5) {
                // Title row: repo name + session count badge
                HStack(spacing: 6) {
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
                if let title = space.latestSessionTitle, !title.isEmpty {
                    Label(title, systemImage: "bubble.left.fill")
                        .font(.subheadline)
                        .foregroundStyle(.primary.opacity(0.84))
                        .lineLimit(1)
                }

                // Metadata row: owner/repo (if different) + timestamp + branch
                HStack(spacing: 6) {
                    if let path = displayPath, path != space.repoName {
                        Text(path)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let date = dateLabel {
                        Text("·")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                        Text(date)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    if !space.branch.isEmpty {
                        Text("·")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                        Label(space.branch, systemImage: "arrow.triangle.branch")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.primary.opacity(0.07)))
    }
}
