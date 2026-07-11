import SwiftUI
import WaynodeCore

// MARK: - SessionDetail
//
// The detail column. A segmented control switches between Chat and
// Terminal, plus a toolbar button for Git Inspector.
//
// Owns the SessionStore lifecycle: acquire on appear, release on disappear
// (which schedules a 30s close timer — see SessionStore).

struct SessionDetail: View {
    @Environment(AppModel.self) private var appModel
    let sessionId: String
    let spaceId: String

    @State private var detailTab: DetailTab = .chat
    @State private var showingGitInspector = false
    @State private var showingSessionSettings = false

    enum DetailTab: String, CaseIterable, Hashable {
        case chat, terminal

        var label: String { self == .chat ? "Chat" : "Terminal" }
        var systemImage: String { self == .chat ? "bubble.left.and.bubble.right" : "terminal" }
    }

    var body: some View {
        @Bindable var store = appModel.store(for: sessionId, spaceId: spaceId)

        VStack(spacing: 0) {
            switch detailTab {
            case .chat:
                ChatView(store: store)
            case .terminal:
                TerminalView(sessionId: sessionId, spaceId: spaceId)
            }
        }
        .navigationTitle(store.sessionMeta?.title ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if detailTab == .chat {
                    Button {
                        showingGitInspector = true
                    } label: {
                        Label("Git worktree", systemImage: "arrow.triangle.branch")
                    }
                    .accessibilityHint("Review changed files, commits, branches, and sync status")

                    Menu {
                        Button {
                            showingSessionSettings = true
                        } label: {
                            Label("Session Settings", systemImage: "slider.horizontal.3")
                        }
                        Divider()
                        Button(role: .destructive) {
                            Task { await store.abortTurn() }
                        } label: {
                            Label("Abort Agent", systemImage: "stop.fill")
                        }
                        .disabled(store.goalStatus.status != .active)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .sheet(isPresented: $showingGitInspector) {
            GitInspector(spaceId: spaceId)
        }
        .sheet(isPresented: $showingSessionSettings) {
            SessionSettingsSheet(store: store)
                .presentationDetents([.medium])
        }
        .task {
            await store.acquire()
        }
        .onDisappear {
            store.release()
        }
    }
}

// MARK: - Session Settings Sheet

struct SessionSettingsSheet: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: SessionStore
    @State private var models: [ModelOption] = []
    @State private var selectedModel: String?
    @State private var isApplyingModel: Bool = false
    @State private var modelError: String?
    @State private var showingDeleteConfirm = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Model") {
                    if models.isEmpty {
                        HStack {
                            ProgressView()
                                .controlSize(.small)
                            Text("Loading models…")
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Picker("Model", selection: Binding(
                            get: { selectedModel },
                            set: { newValue in
                                selectedModel = newValue
                                if let newValue { applyModel(newValue) }
                            }
                        )) {
                            ForEach(models) { model in
                                Text(model.name).tag(model.id as String?)
                            }
                        }
                        if isApplyingModel {
                            HStack(spacing: 6) {
                                ProgressView()
                                    .controlSize(.mini)
                                Text("Applying…")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        if let modelError {
                            Label(modelError, systemImage: "exclamationmark.triangle")
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
                }

                Section("Goal Status") {
                    if store.goalStatus.status != nil {
                        GoalStatusSummary(status: store.goalStatus)
                    } else {
                        Text("No active goal")
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Connection") {
                    LabeledContent("Status") {
                        ConnectionStateBadge(state: store.connectionState)
                    }
                    LabeledContent("Session ID") {
                        Text(store.sessionId.prefix(8) + "…")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                Section {
                    Button(role: .destructive) {
                        showingDeleteConfirm = true
                    } label: {
                        Label("Delete Session", systemImage: "trash")
                    }
                }
            }
            .navigationTitle("Session Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                await appModel.refreshModels()
                models = appModel.models
                // Load the current model from the session metadata
                selectedModel = store.sessionMeta?.model ?? models.first?.id
            }
            .confirmationDialog(
                "Delete Session?",
                isPresented: $showingDeleteConfirm,
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    Haptics.rigid()
                    Task {
                        await appModel.deleteSession(store.sessionId)
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This will permanently delete the session and all its messages. This cannot be undone.")
            }
        }
    }

    // MARK: - Apply model

    private func applyModel(_ modelId: String) {
        guard let api = appModel.currentAPI() else {
            modelError = "Not connected to server"
            selectedModel = store.sessionMeta?.model
            Haptics.error()
            return
        }
        modelError = nil
        isApplyingModel = true
        Task {
            do {
                _ = try await api.setSessionModel(store.sessionId, model: modelId)
                // Update local session meta so UI stays in sync
                store.sessionMeta?.model = modelId
                Haptics.success()
            } catch {
                modelError = error.localizedDescription
                // Revert selection to the stored model
                selectedModel = store.sessionMeta?.model
                Haptics.error()
            }
            isApplyingModel = false
        }
    }
}
