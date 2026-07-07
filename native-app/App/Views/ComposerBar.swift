import SwiftUI
import WaynodeCore

// MARK: - ComposerBar
//
// The bottom input bar. Contains:
//   • A rounded text editor (auto-growing, up to a max height)
//   • A "Send as Goal" toggle (glass icon button on the left)
//   • The Send button (.glassProminent) or Abort button when streaming
//
// UX design:
//   • The composer sits in .safeAreaInset(edge: .bottom) via ChatView's
//     VStack, so it stays pinned above the keyboard.
//   • The FocusState binding lets ChatView auto-focus on appear and
//     tap-to-focus on the message list.
//   • Liquid Glass material for the functional layer.
//   • Smooth send animation (scale + opacity transition on the button).

struct ComposerBar: View {
    @Binding var text: String
    let isSending: Bool
    let error: String?
    let isGoalActive: Bool
    var isFocused: FocusState<Bool>.Binding
    var onSend: (String, Bool) -> Void
    var onAbort: () -> Void

    @State private var isGoalMode: Bool = false

    private let minHeight: CGFloat = 38
    private let maxHeight: CGFloat = 160

    var body: some View {
        VStack(spacing: 0) {
            // Error banner
            if let error {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                    Text(error)
                        .font(.caption)
                        .lineLimit(2)
                    Spacer()
                }
                .foregroundStyle(.red)
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .transition(.opacity)
            }

            VStack(spacing: 6) {
                // Goal mode toggle + hint
                if isGoalMode && !isGoalActive {
                    HStack(spacing: 6) {
                        Image(systemName: "target")
                            .font(.caption2)
                        Text("Send as Goal — the agent will work autonomously until done")
                            .font(.caption2)
                        Spacer()
                    }
                    .foregroundStyle(.tint)
                    .padding(.horizontal, 4)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                }

                HStack(alignment: .bottom, spacing: 8) {
                    // Goal mode toggle
                    Button {
                        Haptics.light()
                        withAnimation(.smooth) { isGoalMode.toggle() }
                    } label: {
                        Image(systemName: isGoalMode ? "target" : "scope")
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(isGoalMode ? Color.accentColor : Color.secondary)
                            .frame(width: 34, height: 34)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                    .disabled(isGoalActive)
                    .help("Send as Goal")
                    .accessibilityLabel(isGoalMode ? "Disable goal mode" : "Enable goal mode")

                    // Text editor with placeholder
                    ZStack(alignment: .topLeading) {
                        if text.isEmpty {
                            Text(placeholder)
                                .font(.body)
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .allowsHitTesting(false)
                        }
                        TextEditor(text: $text)
                            .font(.body)
                            .scrollContentBackground(.hidden)
                            .background(Color.clear)
                            .focused(isFocused)
                            .frame(minHeight: minHeight, maxHeight: maxHeight)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                    }
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(borderColor, lineWidth: isFocused.wrappedValue ? 2 : 0.5)
                    )
                    .animation(.smooth, value: isFocused.wrappedValue)
                    // Tap on the editor area also focuses (belt-and-suspenders
                    // with the FocusState binding from ChatView).
                    .onTapGesture {
                        isFocused.wrappedValue = true
                    }

                    // Send / Abort
                    sendOrAbortButton
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 8)
        }
        .animation(.smooth, value: error != nil)
        .animation(.smooth, value: isSending)
        .animation(.smooth, value: isGoalActive)
        .animation(.smooth, value: isGoalMode)
        .background(.bar)
    }

    @ViewBuilder
    private var sendOrAbortButton: some View {
        if isSending || isGoalActive {
            Button(action: onAbort) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(.red)
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.glass)
            .controlSize(.large)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel(isGoalActive ? "Abort goal" : "Stop generation")
        } else {
            Button {
                send()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 18, weight: .bold))
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Send message")
        }
    }

    private var placeholder: String {
        if isSending { return "Agent is responding…" }
        if isGoalActive { return "Agent is working on goal…" }
        if isGoalMode { return "Describe what you want the agent to achieve…" }
        return "Message…"
    }

    private var borderColor: Color {
        if isGoalMode && !isGoalActive { return Color.accentColor.opacity(0.5) }
        if isFocused.wrappedValue { return Color.accentColor.opacity(0.6) }
        return Color.gray.opacity(0.25)
    }

    private func send() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Haptics.light()
        onSend(trimmed, isGoalMode)
        // Reset goal mode after sending a goal
        if isGoalMode {
            withAnimation(.smooth) { isGoalMode = false }
        }
        // Keep focus so the keyboard stays open for the next message
        isFocused.wrappedValue = true
    }
}
