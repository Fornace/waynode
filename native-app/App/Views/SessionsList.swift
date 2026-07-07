import SwiftUI
import WaynodeCore

// MARK: - SessionsList
//
// The middle column: sessions within the selected space. Tapping a session
// drives the detail column (SessionDetail).
//
// New session button in the toolbar. Swipe to delete. Archive support.

struct SessionsList: View {
    @Environment(AppModel.self) private var appModel
    let spaceId: String
    @State private var showingNewSession = false
    @State private var newSessionTitle = ""
    @State private var sessionError: String?
    @State private var sessionToDelete: Session?
    @State private var searchText = ""

    private var sessions: [Session] {
        let all = appModel.sessions(forSpace: spaceId)
        if searchText.isEmpty {
            return all
        }
        return all.filter { session in
            session.title.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        List(selection: Binding(
            get: { appModel.selectedSessionId },
            set: { appModel.selectedSessionId = $0 }
        )) {
            if sessions.isEmpty {
                if appModel.isLoadingSessions {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if let err = appModel.sessionsError {
                    ContentUnavailableView {
                        Label("Couldn't load sessions", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(err)
                    } actions: {
                        Button("Retry") {
                            Task { await appModel.refreshSessions(spaceId: spaceId) }
                        }
                        .buttonStyle(.glass)
                    }
                    .listRowBackground(Color.clear)
                } else if !searchText.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                        .listRowBackground(Color.clear)
                } else {
                    ContentUnavailableView(
                        "No Sessions",
                        systemImage: "plus.bubble",
                        description: Text("Create a session to start a conversation.")
                    )
                    .listRowBackground(Color.clear)
                }
            } else {
                ForEach(sessions) { session in
                    SessionRow(session: session)
                        .tag(session.id)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                sessionToDelete = session
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                }
            }
        }
        .navigationTitle(spaceName)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Search sessions")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Haptics.light()
                    showingNewSession = true
                } label: {
                    Label("New Session", systemImage: "plus.bubble")
                }
                .buttonStyle(.glass)
            }
        }
        .sheet(isPresented: $showingNewSession) {
            NewSessionSheet(
                title: $newSessionTitle,
                error: $sessionError,
                onCreate: {
                    Task {
                        do {
                            let session = try await appModel.createSession(
                                spaceId: spaceId,
                                title: newSessionTitle.isEmpty ? nil : newSessionTitle
                            )
                            appModel.selectedSessionId = session.id
                            newSessionTitle = ""
                            showingNewSession = false
                            Haptics.success()
                        } catch {
                            sessionError = error.localizedDescription
                            Haptics.error()
                        }
                    }
                },
                onCancel: {
                    newSessionTitle = ""
                    showingNewSession = false
                }
            )
            .presentationDetents([.medium])
        }
        .confirmationDialog(
            "Delete Session?",
            isPresented: Binding(
                get: { sessionToDelete != nil },
                set: { if !$0 { sessionToDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let session = sessionToDelete {
                    Haptics.rigid()
                    Task { await appModel.deleteSession(session.id) }
                }
                sessionToDelete = nil
            }
            Button("Cancel", role: .cancel) { sessionToDelete = nil }
        } message: {
            Text("This action cannot be undone.")
        }
        .refreshable {
            await appModel.refreshSessions(spaceId: spaceId)
        }
        .task {
            if sessions.isEmpty {
                await appModel.refreshSessions(spaceId: spaceId)
            }
        }
    }

    private var spaceName: String {
        appModel.spaces.first { $0.id == spaceId }?.repoName ?? "Sessions"
    }
}

// MARK: - New Session Sheet

struct NewSessionSheet: View {
    @Binding var title: String
    @Binding var error: String?
    var onCreate: () -> Void
    var onCancel: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                TextField("Session title (optional)", text: $title)
                    .submitLabel(.done)

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create", action: onCreate)
                        .buttonStyle(.glassProminent)
                }
            }
        }
    }
}

// MARK: - SessionRow

struct SessionRow: View {
    let session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(session.title.isEmpty ? "Untitled" : session.title)
                    .font(.headline)
                    .lineLimit(1)
                if session.archived {
                    Image(systemName: "archivebox.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            let rel = Format.compactRelative(fromISO: session.createdAt)
            if !rel.isEmpty {
                Text(rel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
