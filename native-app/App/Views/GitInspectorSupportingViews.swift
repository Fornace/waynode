import SwiftUI
import WaynodeCore

enum GitDiffState: Equatable {
    case idle
    case loading
    case loaded(String)
    case failed(String)
}

struct GitFileRow: View {
    let file: GitFile
    let isSelected: Bool
    var allowsWrapping = false

    var body: some View {
        HStack {
            if isSelected {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
            }
            Image(systemName: statusIcon).foregroundStyle(statusColor).font(.caption)
            Text(file.path)
                .font(.caption.monospaced())
                .lineLimit(allowsWrapping ? 2 : 1)
                .truncationMode(.middle)
                .help(file.path)
            Spacer()
        }
        .accessibilityElement(children: .combine)
    }

    private var statusIcon: String {
        switch file.status.first?.uppercased() {
        case "M": "pencil"
        case "A": "plus"
        case "D": "minus"
        case "R": "arrow.right"
        case "U": "questionmark"
        default: "doc"
        }
    }

    private var statusColor: Color {
        switch file.status.first?.uppercased() {
        case "M": .orange
        case "A": .green
        case "D": .red
        case "U": .red
        case "R", "C": .blue
        default: .secondary
        }
    }
}

struct GitInlineDiffPane: View {
    let file: GitFile?
    @Binding var state: GitDiffState
    var onLoad: (GitFile) async -> Void

    var body: some View {
        Group {
            if let file {
                VStack(spacing: 0) {
                    ScrollView([.horizontal, .vertical]) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 8) {
                                Image(systemName: "doc.text.magnifyingglass")
                                Text(file.path)
                                    .font(.headline.monospaced())
                                    .textSelection(.enabled)
                            }
                            .padding(.bottom, 14)
                            switch state {
                            case .loaded(let diff):
                                if diff.isEmpty {
                                    noTextDiff
                                } else {
                                    ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                                        DiffLineView(line: line)
                                    }
                                }
                            case .failed(let message):
                                ContentUnavailableView {
                                    Label("Couldn’t Load Diff", systemImage: "exclamationmark.triangle")
                                } description: {
                                    Text(message)
                                } actions: {
                                    Button("Retry") { Task { await onLoad(file) } }
                                        .accessibilityIdentifier("git.diff.retry")
                                }
                                .accessibilityIdentifier("git.diff.failure")
                            case .idle, .loading:
                                ProgressView("Loading diff…").padding()
                            }
                        }
                        .padding(16)
                        .fixedSize(horizontal: true, vertical: false)
                    }
                }
                .task(id: file.id) {
                    state = .idle
                    await onLoad(file)
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("git.diff.inline")
            } else {
                ContentUnavailableView(
                    "Choose a File",
                    systemImage: "doc.text.magnifyingglass",
                    description: Text("Review a changed file here without leaving the worktree.")
                )
                .accessibilityIdentifier("git.diff.inline.empty")
            }
        }
        .background(.background)
    }

    private var noTextDiff: some View {
        ContentUnavailableView(
            "No Text Diff",
            systemImage: "doc",
            description: Text("This file has no textual changes to display.")
        )
    }
}

struct FileDiffSheet: View {
    let filePath: String
    @Binding var state: GitDiffState
    var onLoad: () async -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    Text(filePath)
                        .font(.caption.monospaced().weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .padding(.bottom, 8)
                        .accessibilityLabel("File: \(filePath)")
                        .accessibilitySortPriority(2)
                    switch state {
                    case .loaded(let diff):
                        if diff.isEmpty {
                            ContentUnavailableView(
                                "No Text Diff",
                                systemImage: "doc",
                                description: Text("This file has no textual changes to display.")
                            )
                        } else {
                            ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                                DiffLineView(line: line)
                            }
                        }
                    case .failed(let message):
                        VStack(alignment: .leading, spacing: 14) {
                            Label("Couldn’t Load Diff", systemImage: "doc.text.magnifyingglass")
                                .font(.headline)
                            Text(message)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                            Button {
                                Task { await onLoad() }
                            } label: {
                                Label("Retry", systemImage: "arrow.clockwise")
                            }
                            .buttonStyle(.borderedProminent)
                                .accessibilityIdentifier("git.diff.retry")
                        }
                        .frame(minWidth: 280, alignment: .leading)
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("git.diff.failure")
                    case .idle, .loading:
                        ProgressView("Loading diff…").padding()
                    }
                }
                .padding(8)
                .fixedSize(horizontal: true, vertical: false)
            }
            .navigationTitle("File Diff")
            .platformInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("git.diff.done")
                        .accessibilityHint("Closes the file diff")
                }
            }
            .task {
                if state == .idle { await onLoad() }
            }
            .onDisappear { state = .idle }
        }
        .macSheetFrame(minWidth: 640, idealWidth: 820, maxWidth: 1_100, minHeight: 520, idealHeight: 720)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("git.diff.surface")
    }
}

struct DiffLineView: View {
    let line: String

    var body: some View {
        Text(line.isEmpty ? " " : line)
            .font(.system(.caption2, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(backgroundColor)
            .foregroundStyle(foregroundColor)
            .accessibilityLabel(accessibilityLine)
    }

    private var backgroundColor: Color {
        if line.hasPrefix("+") { return .green.opacity(0.15) }
        if line.hasPrefix("-") { return .red.opacity(0.15) }
        if line.hasPrefix("@@") { return .accentColor.opacity(0.1) }
        return .clear
    }

    private var foregroundColor: Color {
        // Keep text at the platform primary contrast level in both light and
        // dark appearances; the tinted background and spoken prefix carry
        // the change type without relying on color alone.
        return .primary
    }

    private var accessibilityLine: String {
        if line.hasPrefix("+") { return "Added: \(line.dropFirst())" }
        if line.hasPrefix("-") { return "Removed: \(line.dropFirst())" }
        if line.hasPrefix("@@") { return "Diff section: \(line)" }
        return line.isEmpty ? "Blank line" : line
    }
}

struct CommitSheet: View {
    @Binding var message: String
    let files: [String]
    @Binding var isCommitting: Bool
    @Binding var error: String?
    var onCommit: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var showsFiles = false
    @FocusState private var messageFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section("Commit Message") {
                    TextField("Enter commit message…", text: $message, axis: .vertical).lineLimit(3...6)
                        .focused($messageFocused)
                        .accessibilityIdentifier("git.commit.message")
                        .accessibilityHint("Describe the selected changes")
                }
                Section {
                    DisclosureGroup("\(files.count) selected file\(files.count == 1 ? "" : "s")", isExpanded: $showsFiles) {
                        ForEach(files, id: \.self) { file in
                            Text(file)
                                .font(.caption.monospaced())
                                .lineLimit(2)
                                .truncationMode(.middle)
                                .textSelection(.enabled)
                        }
                    }
                    .accessibilityIdentifier("git.commit.files.disclosure")
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .accessibilityLabel("Commit error: \(error)")
                    }
                }
            }
            .navigationTitle("Commit")
            .platformInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isCommitting)
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("git.commit.cancel")
                        .accessibilityHint("Closes without committing")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isCommitting ? "Committing…" : "Commit", action: onCommit)
                        .buttonStyle(.glassProminent)
                        .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCommitting)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("git.commit.confirm")
                        .accessibilityHint("Commits the selected files")
                }
            }
            .interactiveDismissDisabled(isCommitting)
            .onAppear { messageFocused = true }
        }
        .macSheetFrame(minWidth: 520, idealWidth: 620, maxWidth: 760, minHeight: 480, idealHeight: 600, maxHeight: 760)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("git.commit.surface")
    }
}
