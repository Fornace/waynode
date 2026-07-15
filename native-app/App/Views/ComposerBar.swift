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
    var isFocused: FocusState<Bool>.Binding
    var onAttach: () -> Void
    var onSend: (String, Bool) -> Void
    var onAbort: () -> Void

    @State private var isGoalMode: Bool = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            // Error banner (conditional)
            if let error {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
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
                    GoalTensionGlyph(active: true, reduceMotion: reduceMotion)
                        .frame(width: 16, height: 16)
                    Text("Goal mode · Waynode keeps working until done")
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
                    .accessibilityLabel("Message")
                    .accessibilityHint("Type a message for the coding agent")
                    .accessibilityIdentifier("composer.input")

                Button {
                    Haptics.light()
                    withAnimation(reduceMotion ? nil : .smooth) { isGoalMode.toggle() }
                } label: {
                    GoalTensionGlyph(active: isGoalMode, reduceMotion: reduceMotion)
                        .frame(width: 24, height: 24)
                        .frame(width: 32, height: 32)
                        .background(
                            isGoalMode ? Color.accentColor.opacity(0.12) : Color.clear,
                            in: Circle()
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isGoalMode ? "Disable goal mode" : "Enable goal mode")
                .accessibilityHint("Goal mode keeps working until the goal is complete")
                .accessibilityIdentifier("composer.goal")
                .frame(minWidth: 44, minHeight: 44)

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
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(
                        isFocused.wrappedValue
                            ? Color.accentColor.opacity(0.85)
                            : Color.secondary.opacity(0.25),
                        lineWidth: isFocused.wrappedValue ? 1.5 : 1
                    )
            )
            .padding(.horizontal, 10)
            .padding(.top, 4)
            .padding(.bottom, 6)
            .animation(reduceMotion ? nil : .smooth, value: isFocused.wrappedValue)
        }
        .background(.bar)
        .animation(reduceMotion ? nil : .smooth, value: error != nil)
        .animation(reduceMotion ? nil : .smooth, value: isSending)
        .animation(reduceMotion ? nil : .smooth, value: isRunActive)
        .animation(reduceMotion ? nil : .smooth, value: isGoalActive)
        .animation(reduceMotion ? nil : .smooth, value: isGoalMode)
    }

    // MARK: - Send / Abort

    @ViewBuilder
    private var sendOrAbortButton: some View {
        if isRunActive || isGoalActive {
            HStack(spacing: 0) {
                if canSend {
                    Button { send() } label: {
                        Image(systemName: "text.badge.plus")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.accentColor)
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
        if isGoalMode { return "Describe the goal…" }
        return "Message"
    }

    private func send() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Haptics.light()
        onSend(trimmed, isGoalMode)
        if isGoalMode {
            withAnimation(reduceMotion ? nil : .smooth) { isGoalMode = false }
        }
        // Keep focus so the keyboard stays open for the next message
        isFocused.wrappedValue = true
    }

    private func errorAccessibilityLabel(_ error: String) -> String {
        guard !text.isEmpty else { return error }
        return "Message not sent. \(error). Your draft is still available. Send again to retry."
    }
}

private struct GoalTensionGlyph: View {
    let active: Bool
    let reduceMotion: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 24, paused: reduceMotion || !active)) { timeline in
            let seconds = timeline.date.timeIntervalSinceReferenceDate
            let pull: CGFloat = reduceMotion || !active ? 0 : CGFloat(sin(seconds * 2.2)) * 1.15
            Canvas { context, size in
                let sx = size.width / 24
                let sy = size.height / 24
                let points = [
                    CGPoint(x: 3 * sx, y: (5 + pull) * sy),
                    CGPoint(x: 7 * sx, y: (18 - pull * 0.35) * sy),
                    CGPoint(x: 12 * sx, y: (10 - pull) * sy),
                    CGPoint(x: 17 * sx, y: (18 + pull * 0.35) * sy),
                    CGPoint(x: 21 * sx, y: (4 - pull) * sy)
                ]
                var tension = Path()
                tension.move(to: points[0])
                points.dropFirst().forEach { tension.addLine(to: $0) }
                let color = active ? Color.accentColor : Color.secondary
                context.stroke(tension, with: .color(color), lineWidth: active ? 1.8 : 1.4)
                for point in points {
                    let node = CGRect(x: point.x - 1.8, y: point.y - 1.8, width: 3.6, height: 3.6)
                    context.fill(Path(ellipseIn: node), with: .color(color))
                }
            }
        }
        .accessibilityHidden(true)
    }
}
