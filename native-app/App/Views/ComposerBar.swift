import SwiftUI
import WaynodeCore

// MARK: - ComposerBar
//
// Compact bottom input bar — modeled after Messages / ChatGPT / Claude iOS.
//
// Design:
//   • Single-line by default, auto-grows to max ~6 lines via
//     TextField(axis: .vertical) + lineLimit(1...6). This avoids the
//     classic SwiftUI TextEditor greedy-height bug where the editor
//     expands to fill all available vertical space.
//   • Rounded capsule shape, .thinMaterial background.
//   • Attachment on the left; Goal mode sits beside Send because it modifies
//     what Send does. Both remain inside one calm input surface.
//   • Pinned to the bottom via safeAreaInset — stays above the keyboard.

struct ComposerBar: View {
    @Binding var text: String
    let isSending: Bool
    let isRunActive: Bool
    let isAttaching: Bool
    let error: String?
    let isGoalActive: Bool
    let hammersmithAvailable: Bool
    var isFocused: FocusState<Bool>.Binding
    var onAttach: () -> Void
    var onSend: (String, Bool) -> Void
    var onSendHammersmith: (String) -> Void
    var onAbort: () -> Void

    private enum ComposerMode { case message, goal, hammersmith }
    @State private var composerMode: ComposerMode = .message

    /// Everything the bar animates on, as one Equatable value — drives a
    /// single .animation node instead of five stacked whole-bar transactions.
    private struct BarPhase: Equatable {
        let hasError: Bool
        let isSending: Bool
        let isRunActive: Bool
        let isGoalActive: Bool
        let mode: ComposerMode
    }
    private var barPhase: BarPhase {
        .init(hasError: error != nil, isSending: isSending, isRunActive: isRunActive,
              isGoalActive: isGoalActive, mode: composerMode)
    }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isGoalMode: Bool { composerMode == .goal }
    private var isHammersmithMode: Bool { composerMode == .hammersmith }

    var body: some View {
        VStack(spacing: 0) {
            // Mode Picker
            Picker("Send Mode", selection: $composerMode) {
                Label("Chat", systemImage: "bubble.left.and.bubble.right")
                    .tag(ComposerMode.message)
                Label("Goal", systemImage: "target")
                    .tag(ComposerMode.goal)
                if hammersmithAvailable {
                    Label("Swarm", systemImage: "person.3.sequence")
                        .tag(ComposerMode.hammersmith)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 10)
            .padding(.top, 4)
            .padding(.bottom, 4)

            // Error banner (conditional)
            if let error {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .symbolEffect(.bounce, value: error)
                    Text(error)
                        .font(.caption2)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                }
                .foregroundStyle(.red)
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .transition(.opacity)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(errorAccessibilityLabel(error))
                .accessibilityIdentifier("composer.error")
            }

            // Goal-mode hint strip
            if isGoalMode {
                HStack(spacing: 6) {
                    Image(systemName: "target")
                        .font(.caption2)
                        .symbolEffect(.pulse, isActive: !reduceMotion)
                    Text("Goal mode · Waynode keeps working until done")
                        .font(.caption2)
                    Spacer()
                }
                .foregroundStyle(.tint)
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            // Hammersmith-mode hint strip
            if isHammersmithMode {
                HStack(spacing: 6) {
                    Image(systemName: "person.3.sequence.fill")
                        .font(.caption2)
                        .symbolEffect(.pulse, isActive: !reduceMotion)
                    Text("Hammersmith · delegates this job to a verified swarm")
                        .font(.caption2)
                    Spacer()
                }
                .foregroundStyle(.tint)
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            // The input capsule — a distinct floating pill inside the bar.
            // Centered alignment keeps the goal toggle, placeholder text, and
            // send button on a shared baseline when single-line (the common
            // case); the field still grows vertically for multiline input.
            HStack(alignment: .center, spacing: 4) {
                Button(action: onAttach) {
                    Group {
                        if isAttaching {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "paperclip")
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(Color.secondary)
                        }
                    }
                    .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .disabled(isAttaching)
                .accessibilityLabel("Attach files")
                .accessibilityHint("Adds files to this workspace")
                .accessibilityIdentifier("composer.attachment")
                .frame(minWidth: 44, minHeight: 44)

                // Auto-growing text field — the key fix.
                // TextField(axis: .vertical) + lineLimit properly constrains
                // height unlike TextEditor which expands greedily.
                TextField(placeholder, text: $text, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...6)
                    .focused(isFocused)
                    .padding(.horizontal, 2)
                    .padding(.vertical, 7)
                    .frame(minHeight: 32)
                    .submitLabel(.send)
                    .onSubmit { send() }
                    .accessibilityLabel("Message")
                    .accessibilityHint("Type a message for the coding agent")
                    .accessibilityIdentifier("composer.input")

                // Send / Abort
                sendOrAbortButton
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(.thinMaterial)
            )
            .overlay(
                // The focus animation lives on the stroke alone. Attached to
                // the whole capsule it implicitly animated every animatable
                // attribute in the subtree (material, paddings, TextField
                // frame) and that pass raced the keyboard bring-up.
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(
                        isFocused.wrappedValue
                            ? Color.accentColor.opacity(0.85)
                            : Color.secondary.opacity(0.25),
                        lineWidth: isFocused.wrappedValue ? 1.5 : 1
                    )
                    .animation(reduceMotion ? nil : .smooth, value: isFocused.wrappedValue)
            )
            .padding(.horizontal, 10)
            .padding(.top, 4)
            .padding(.bottom, 6)
        }
        .background(.bar)
        // One animation node keyed on the bar's whole phase instead of five
        // stacked whole-bar transactions — same insert/remove transitions.
        .animation(reduceMotion ? nil : .smooth, value: barPhase)
        .onChange(of: hammersmithAvailable) { _, available in
            if !available, isHammersmithMode { composerMode = .message }
        }
    }

    // MARK: - Send / Abort

    @ViewBuilder
    private var sendOrAbortButton: some View {
        if isRunActive || isGoalActive {
            HStack(spacing: 0) {
                if canSend {
                    Button { send() } label: {
                        Image(systemName: isGoalMode ? "target" : "text.badge.plus")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.accentColor)
                            .symbolEffect(.bounce, value: canSend)
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .disabled(isSending)
                    .accessibilityLabel(isGoalMode ? "Queue goal" : "Queue message")
                    .accessibilityIdentifier("composer.queue")
                    .accessibilityHint("Adds this draft after the active run")
                    .frame(minWidth: 44, minHeight: 44)
                }
            Button(action: onAbort) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(Color.red, in: Circle())
            }
            .buttonStyle(.plain)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel(isGoalActive ? "Abort goal" : "Stop generation")
            .accessibilityIdentifier("composer.stop")
            .frame(minWidth: 44, minHeight: 44)
            }
        } else {
            Button {
                send()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(
                        canSend ? Color.accentColor : Color.secondary.opacity(0.3),
                        in: Circle()
                    )
            }
            .buttonStyle(.plain)
            .disabled(!canSend || isSending)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("composer.send")
            .accessibilityHint("Sends the current draft")
            .keyboardShortcut(.return, modifiers: .command)
            .frame(minWidth: 44, minHeight: 44)
        }
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var placeholder: String {
        if isRunActive || isGoalActive { return "Add a follow-up…" }
        if isSending { return "Sending…" }
        if isHammersmithMode { return "Describe the job…" }
        if isGoalMode { return "Describe the goal…" }
        return "Message"
    }

    private func send() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Haptics.light()
        if isHammersmithMode {
            onSendHammersmith(trimmed)
            withAnimation(reduceMotion ? nil : .smooth) { composerMode = .message }
        } else {
            onSend(trimmed, isGoalMode)
            if isGoalMode {
                withAnimation(reduceMotion ? nil : .smooth) { composerMode = .message }
            }
        }
        // Keep focus so the keyboard stays open for the next message
        isFocused.wrappedValue = true
    }

    private func errorAccessibilityLabel(_ error: String) -> String {
        guard !text.isEmpty else { return error }
        return "Message not sent. \(error). Your draft is still available. Send again to retry."
    }
}

