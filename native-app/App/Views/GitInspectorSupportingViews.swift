import SwiftUI
import WaynodeCore

struct GitFileRow: View {
    let file: GitFile
    let isSelected: Bool

    var body: some View {
        HStack {
            if isSelected {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
            }
            Image(systemName: statusIcon).foregroundStyle(statusColor).font(.caption)
            Text(file.path).font(.caption.monospaced()).lineLimit(1)
            Spacer()
        }
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
        default: .secondary
        }
    }
}

struct FileDiffSheet: View {
    let filePath: String
    @Binding var diff: String?
    var onLoad: () async -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let diff {
                        ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                            DiffLineView(line: line)
                        }
                    } else {
                        ProgressView("Loading diff…").padding()
                    }
                }
                .padding(8)
            }
            .navigationTitle(filePath)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { if diff == nil { await onLoad() } }
        }
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
    }

    private var backgroundColor: Color {
        if line.hasPrefix("+") { return .green.opacity(0.15) }
        if line.hasPrefix("-") { return .red.opacity(0.15) }
        if line.hasPrefix("@@") { return .accentColor.opacity(0.1) }
        return .clear
    }

    private var foregroundColor: Color {
        if line.hasPrefix("+") { return .green }
        if line.hasPrefix("-") { return .red }
        if line.hasPrefix("@@") { return .accentColor }
        return .primary
    }
}

struct CommitSheet: View {
    @Binding var message: String
    let files: [String]
    @Binding var isCommitting: Bool
    @Binding var error: String?
    var onCommit: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Commit Message") {
                    TextField("Enter commit message…", text: $message, axis: .vertical).lineLimit(3...6)
                }
                Section("Files (\(files.count))") {
                    ForEach(files, id: \.self) { file in Text(file).font(.caption.monospaced()) }
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
            }
            .navigationTitle("Commit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Commit", action: onCommit)
                        .buttonStyle(.glassProminent)
                        .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCommitting)
                }
            }
        }
    }
}
