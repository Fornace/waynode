import SwiftUI
import WaynodeCore

// MARK: - SpacesSidebar
//
// The leftmost column: a list of spaces (cloned repos). Tapping a space
// selects it, which drives the SessionsList in the content column.
//
// Swipe-to-delete on spaces. "Clone Repo" button at the bottom opens the
// CloneSheet.

struct SpacesSidebar: View {
    @Environment(AppModel.self) private var appModel
    @State private var showingCloneSheet = false
    @State private var spaceToDelete: Space?
    @State private var cloneError: String?
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
        List(selection: Binding(
            get: { appModel.selectedSpaceId },
            set: { appModel.selectedSpaceId = $0 }
        )) {
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
                    SpaceRow(space: space)
                        .tag(space.id)
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
                    cloneError = nil
                    showingCloneSheet = true
                } label: {
                    Label("Clone Repo", systemImage: "plus")
                }
                .buttonStyle(.glass)
            }
        }
        .sheet(isPresented: $showingCloneSheet) {
            CloneSheet(
                error: $cloneError,
                onClone: { url, branch in
                    Task {
                        do {
                            let space = try await appModel.createSpace(repoUrl: url, branch: branch)
                            appModel.selectedSpaceId = space.id
                            showingCloneSheet = false
                            Haptics.success()
                        } catch {
                            cloneError = error.localizedDescription
                            Haptics.error()
                        }
                    }
                },
                onCancel: { showingCloneSheet = false }
            )
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

struct CloneSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var appModel

    @State private var repoURL = ""
    @State private var branch = ""
    @State private var isCloning = false
    @Binding var error: String?

    var onClone: (String, String?) -> Void
    var onCancel: () -> Void

    var body: some View {
        NavigationStack {
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
                        Picker("Org", selection: .constant(appModel.orgs.first?.id ?? "")) {
                            ForEach(appModel.orgs) { org in
                                Text(org.name).tag(org.id)
                            }
                        }
                    }
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Clone Repository")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: error) { _, newError in
                // A failed clone arrives async via the binding; reset the
                // spinner so the user can retry or edit the URL.
                if newError != nil { isCloning = false }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        onCancel()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Clone") {
                        isCloning = true
                        onClone(repoURL, branch.isEmpty ? nil : branch)
                    }
                    .disabled(repoURL.trimmingCharacters(in: .whitespaces).isEmpty || isCloning)
                    .buttonStyle(.glassProminent)
                    .overlay {
                        if isCloning {
                            ProgressView()
                        }
                    }
                }
            }
        }
    }
}
