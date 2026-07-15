import SwiftUI
import WaynodeCore

struct SessionSettingsSheet: View {
    private enum ModelLoadState { case loading, loaded, empty, failed(String) }
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: SessionStore
    @State private var models: [ModelOption] = []
    @State private var selectedModel: String?
    @State private var isApplyingModel = false
    @State private var modelError: String?
    @State private var modelLoadState: ModelLoadState = .loading
    @State private var showingDeleteConfirm = false
    @State private var isDeleting = false

    var body: some View {
        NavigationStack {
            Form {
                modelSection
                goalSection
                connectionSection
                Section {
                    Button(role: .destructive) { showingDeleteConfirm = true } label: {
                        Label(isDeleting ? "Deleting Session…" : "Delete Session", systemImage: "trash")
                    }
                    .disabled(isDeleting)
                    .accessibilityIdentifier("session.delete.request")
                    .accessibilityHint("Asks before permanently deleting this session and its messages")
                }
            }
            .accessibilityIdentifier("session.settings")
            .navigationTitle("Session Settings")
            .platformInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .disabled(isDeleting)
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("session.settings.close")
                }
            }
            .task { await loadModels() }
            .alert("Delete Session?", isPresented: $showingDeleteConfirm) {
                Button("Delete", role: .destructive) { deleteSession() }
                    .accessibilityIdentifier("session.delete.confirm")
                Button("Cancel", role: .cancel) {}
                    .accessibilityIdentifier("session.delete.cancel")
            } message: {
                Text("This will permanently delete the session and all its messages. This cannot be undone.")
            }
        }
        .macSheetFrame(minWidth: 520, idealWidth: 600, minHeight: 520, idealHeight: 620)
    }

    @ViewBuilder private var modelSection: some View {
        Section("Model") {
            switch modelLoadState {
            case .loading:
                ProgressView("Loading models…").controlSize(.small)
                    .accessibilityIdentifier("session.settings.models.loading")
            case .failed(let message):
                modelRecovery(message: message, symbol: "exclamationmark.triangle")
            case .empty:
                modelRecovery(message: "No models are available from this server.", symbol: "cube.transparent")
            case .loaded:
                Picker("Model", selection: Binding(
                    get: { selectedModel },
                    set: { value in
                        selectedModel = value
                        if let value { applyModel(value) }
                    }
                )) {
                    ForEach(models) { Text($0.name).tag($0.id as String?) }
                }
                .disabled(isApplyingModel)
                .accessibilityIdentifier("session.settings.model")
                if isApplyingModel {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Applying…").font(.caption).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Applying model")
                }
                if let modelError {
                    Label(modelError, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .accessibilityLabel("Could not change model: \(modelError)")
                        .accessibilityIdentifier("session.settings.model.error")
                }
            }
        }
    }

    private var goalSection: some View {
        Section("Goal Status") {
            if store.goalStatus.status != nil {
                GoalStatusSummary(status: store.goalStatus)
            } else {
                Text("No active goal").foregroundStyle(.secondary)
            }
        }
    }

    private var connectionSection: some View {
        Section("Connection") {
            LabeledContent("Status") { ConnectionStateBadge(state: store.connectionState) }
            LabeledContent("Session ID") {
                Text(store.sessionId)
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder private func modelRecovery(message: String, symbol: String) -> some View {
        Label(message, systemImage: symbol)
            .font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .accessibilityIdentifier("session.settings.models.message")
        Button("Try Again") { Task { await loadModels() } }
            .accessibilityIdentifier("session.settings.models.retry")
            .accessibilityHint("Requests the model list from the server again")
    }

    private func loadModels() async {
        modelLoadState = .loading
        do {
            models = try await appModel.refreshModels()
            selectedModel = store.sessionMeta?.model ?? models.first?.id
            modelLoadState = models.isEmpty ? .empty : .loaded
        } catch is CancellationError {
            return
        } catch {
            models = []
            modelLoadState = .failed(error.localizedDescription)
        }
    }

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
                store.sessionMeta?.model = modelId
                Haptics.success()
            } catch {
                modelError = error.localizedDescription
                selectedModel = store.sessionMeta?.model
                Haptics.error()
            }
            isApplyingModel = false
        }
    }

    private func deleteSession() {
        Haptics.rigid()
        isDeleting = true
        Task {
            await appModel.deleteSession(store.sessionId)
            if appModel.selectedSessionId == store.sessionId { appModel.selectedSessionId = nil }
            dismiss()
        }
    }
}
