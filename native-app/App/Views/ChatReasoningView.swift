import SwiftUI

// MARK: - Thinking Block
//
// Collapsible reasoning. Now renders its content through MarkdownView so
// code snippets and structured markdown inside the model's reasoning are
// formatted readably instead of dumped as plain text (#5).

struct ThinkingBlock: View {
    let text: String
    let isStreaming: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isExpanded: Bool = false

    private var showsBody: Bool { isStreaming || isExpanded }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                Haptics.light()
                withAnimation(reduceMotion ? nil : .smooth) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 9) {
                    ZStack {
                        Circle()
                            .fill(Color.indigo.opacity(0.16))
                        Image(systemName: isStreaming ? "sparkles" : "brain.head.profile")
                            .font(.caption)
                            .foregroundStyle(Color.indigo)
                            .symbolRenderingMode(.hierarchical)
                            .symbolEffect(.breathe, isActive: isStreaming && !reduceMotion)
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .frame(width: 24, height: 24)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Reasoning")
                            .font(.caption.bold())
                            .foregroundStyle(.primary)
                        Text(isStreaming ? "Streaming thoughts" : (isExpanded ? "Expanded" : "Collapsed"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: showsBody ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .contentTransition(.symbolEffect(.replace))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(isStreaming ? "Reasoning is shown while it streams" : "Expands or collapses reasoning")

            if showsBody {
                ScrollView(.vertical) {
                    ReasoningContentView(text: text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                }
                .frame(maxHeight: isStreaming ? 220 : 360)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.indigo.opacity(0.08))
        )
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(Color.indigo.opacity(isStreaming ? 0.85 : 0.55))
                .frame(width: 3)
                .padding(.vertical, 8)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.indigo.opacity(isStreaming ? 0.28 : 0.16))
        )
    }
}

private struct ReasoningContentView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MarkdownParser.parse(text).enumerated()), id: \.offset) { _, block in
                ReasoningMarkdownBlock(block: block)
            }
        }
        .textSelection(.enabled)
    }
}

private struct ReasoningMarkdownBlock: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Image(systemName: icon(for: level))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.indigo)
                    .frame(width: 14)
                Text(MarkdownInline.attributed(text))
                    .font(level <= 2 ? .subheadline.weight(.semibold) : .caption.weight(.semibold))
                    .foregroundStyle(.primary)
            }
            .padding(.top, level <= 2 ? 2 : 0)

        case .paragraph(let text):
            Text(MarkdownInline.attributed(text, baseColor: .secondary))
                .font(.callout)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 7, style: .continuous))

        case .codeBlock(let language, let code):
            CodeBlockView(language: language, code: code)

        case .listBlock(let ordered, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? item.marker : "•")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.indigo)
                            .frame(width: ordered ? 24 : 12, alignment: .trailing)
                        Text(MarkdownInline.attributed(item.text, baseColor: .secondary))
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(item.depth) * 14)
                    .id(idx)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.indigo.opacity(0.055), in: RoundedRectangle(cornerRadius: 7, style: .continuous))

        case .blockquote(let blocks):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(Color.indigo.opacity(0.55))
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                        ReasoningMarkdownBlock(block: block)
                    }
                }
            }
            .padding(10)
            .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 7, style: .continuous))

        case .table(let header, let alignments, let rows):
            TableView(header: header, alignments: alignments, rows: rows)

        case .thematicBreak:
            Divider()
                .padding(.vertical, 2)
        }
    }

    private func icon(for level: Int) -> String {
        level <= 2 ? "list.bullet.rectangle" : "smallcircle.filled.circle"
    }
}
