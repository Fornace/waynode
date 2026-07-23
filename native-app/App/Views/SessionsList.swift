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
        List {
            if sessions.isEmpty {
                if appModel.isLoadingSessions {
                    ContentUnavailableView {
                        ProgressView()
                    } description: {
                        Text("Loading sessions…")
                    }
                    .listRowBackground(Color.clear)
                } else if let err = appModel.sessionsError {
                    ContentUnavailableView {
                        Label("Couldn’t Load Sessions", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(err)
                    } actions: {
                        Button("Retry") {
                            Task { await appModel.refreshSessions(spaceId: spaceId) }
                        }
                    }
                    .listRowBackground(Color.clear)
                } else if !searchText.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                        .listRowBackground(Color.clear)
                } else {
                    ContentUnavailableView {
                        Label("No Sessions", systemImage: "plus.bubble")
                    } description: {
                        Text("Start a focused conversation in this worktree.")
                    } actions: {
                        Button("New Session") {
                            Haptics.light()
                            showingNewSession = true
                        }
                        .accessibilityIdentifier("session.new")
                    }
                    .listRowBackground(Color.clear)
                }
            } else {
                ForEach(sessions) { session in
                    NavigationLink(value: DeepLink.sessionDetail(spaceId: spaceId, sessionId: session.id)) {
                        SessionRow(session: session)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            sessionToDelete = session
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        .accessibilityIdentifier("session.\(session.id).delete")
                    }
                    .contextMenu {
                        Button(role: .destructive) {
                            sessionToDelete = session
                        } label: {
                            Label("Delete Session", systemImage: "trash")
                        }
                        .accessibilityIdentifier("session.\(session.id).delete")
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sessions.list")
        .navigationTitle(spaceName)
        .platformInlineNavigationTitle()
        .searchable(text: $searchText, prompt: "Search sessions")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Haptics.light()
                    showingNewSession = true
                } label: {
                    Label("New Session", systemImage: "plus.bubble")
                }
                .accessibilityIdentifier("session.new")
            }
        }
        .sheet(isPresented: $showingNewSession) {
            NewSessionSheet(
                title: $newSessionTitle,
                error: $sessionError,
                onCreate: {
                    let trimmedTitle = newSessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    let session = try await appModel.createSession(
                        spaceId: spaceId,
                        title: trimmedTitle.isEmpty ? nil : trimmedTitle
                    )
                    try Task.checkCancellation()
                    newSessionTitle = ""
                    showingNewSession = false
                    Haptics.success()
                    appModel.pendingDeepLink = .sessionDetail(spaceId: spaceId, sessionId: session.id)
                },
                onCancel: {
                    newSessionTitle = ""
                    sessionError = nil
                    showingNewSession = false
                }
            )
            .platformAdaptiveSheet()
        }
        .alert(
            "Delete Session?",
            isPresented: Binding(
                get: { sessionToDelete != nil },
                set: { if !$0 { sessionToDelete = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                if let session = sessionToDelete {
                    Haptics.rigid()
                    Task { await appModel.deleteSession(session.id) }
                }
                sessionToDelete = nil
            }
            .accessibilityIdentifier("session.delete.confirm")
            Button("Cancel", role: .cancel) { sessionToDelete = nil }
                .accessibilityIdentifier("session.delete.cancel")
        } message: {
            if let session = sessionToDelete {
                Text("This permanently deletes \"\(session.title.isEmpty ? "Untitled" : session.title)\" and all its messages. This cannot be undone.")
            } else {
                Text("This action cannot be undone.")
            }
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
    var onCreate: () async throws -> Void
    var onCancel: () -> Void
    @FocusState private var titleFocused: Bool
    @State private var isCreating = false
    @State private var creationTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Session title (optional)", text: $title)
                    .submitLabel(.done)
                    .focused($titleFocused)
                    .onSubmit(submit)
                    .disabled(isCreating)
                    .accessibilityIdentifier("session.new.title")

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .accessibilityLabel("Could not create session: \(error)")
                            .accessibilityIdentifier("session.new.error")
                    }
                }
            }
            .navigationTitle("New Session")
            .platformInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("session.new.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: submit) {
                        if isCreating {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityHidden(true)
                        }
                        Text(isCreating ? "Creating…" : "Create")
                    }
                        .disabled(isCreating)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("session.new.create")
                        .accessibilityHint(isCreating ? "Creating the session" : "Creates and opens the session")
                }
            }
            .onAppear { titleFocused = true }
            .interactiveDismissDisabled(isCreating)
            .onDisappear { creationTask?.cancel() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session.new.surface")
        #if targetEnvironment(macCatalyst) || os(macOS)
        .frame(minWidth: 440, minHeight: 220)
        #endif
    }

    private func submit() {
        guard !isCreating else { return }
        isCreating = true
        error = nil
        creationTask = Task {
            do {
                try await onCreate()
            } catch is CancellationError {
                // Cancellation is an intentional escape path, not an error.
            } catch {
                self.error = error.localizedDescription
                Haptics.error()
            }
            isCreating = false
        }
    }

    private func cancel() {
        creationTask?.cancel()
        creationTask = nil
        isCreating = false
        onCancel()
    }
}

#if DEBUG
/// Deterministic host for exercising session creation independently of
/// navigation state. It uses the production sheet and AppModel mutations.
struct SessionUITestFixtureView: View {
    @Environment(AppModel.self) private var appModel
    let settings: Bool
    @State private var title = ""
    @State private var error: String?
    @State private var createdTitle: String?
    @State private var store: SessionStore?
    @State private var showingNewSession = true
    @State private var showingSettings = false

    var body: some View {
        Group {
            if settings {
                Color.clear
                    .sheet(isPresented: $showingSettings) {
                        if let store { SessionSettingsSheet(store: store) }
                    }
            } else {
                Color.clear
                    .sheet(isPresented: $showingNewSession) {
                        NewSessionSheet(title: $title, error: $error, onCreate: create,
                                        onCancel: { showingNewSession = false })
                        .platformAdaptiveSheet()
                    }
            }
        }
        .task {
            guard settings else { return }
            store = appModel.store(for: "ui-session", spaceId: "ui-space")
            showingSettings = true
        }
        .accessibilityIdentifier(settings ? "session.settings.fixture" : "session.new.fixture")
        .overlay(alignment: .bottom) {
            if let createdTitle {
                Text("Created " + createdTitle)
                    .accessibilityIdentifier("session.new.created")
                    .padding(10)
                    .background(.thinMaterial, in: Capsule())
                    .padding()
            }
            if settings && !showingSettings && store != nil {
                Text(appModel.sessions(forSpace: "ui-space").contains { $0.id == "ui-session" }
                     ? "Settings closed" : "Session deleted")
                    .accessibilityIdentifier("session.settings.result")
                    .padding(10)
                    .background(.thinMaterial, in: Capsule())
                    .padding()
            }
        }
    }

    private func create() async throws {
        let session = try await appModel.createSession(
            spaceId: "ui-space", title: title.isEmpty ? nil : title)
        try Task.checkCancellation()
        createdTitle = session.title
        title = ""
        showingNewSession = false
    }
}
#endif

// MARK: - SessionRow

struct SessionRow: View {
    let session: Session
    var isSelected = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tint)
                .frame(width: 32, height: 32)
                .background(.tint.opacity(0.11), in: RoundedRectangle(cornerRadius: 9))

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(session.title.isEmpty ? "Untitled" : session.title)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if session.archived {
                        Image(systemName: "archivebox.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                let rel = Format.compactRelative(fromISO: session.createdAt)
                if !rel.isEmpty {
                    Label(rel, systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 8)

            if let model = session.model, !model.isEmpty {
                Label(model, systemImage: "cpu")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 112, alignment: .trailing)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .background(isSelected ? Color.accentColor.opacity(0.13) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("session.row.\(session.id)")
        .accessibilityLabel(session.title.isEmpty ? "Untitled session" : session.title)
        .accessibilityValue(session.archived ? "Archived" : (session.model ?? "Active"))
        .accessibilityHint("Open this session")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .help(session.title.isEmpty ? "Untitled session" : session.title)
    }
}
