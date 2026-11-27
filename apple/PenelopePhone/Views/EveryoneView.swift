import PenelopeCore
import SwiftUI

/// 「みんな」: the heading, and under it the agents or the empty list (design guide 18 章「一覧」).
struct EveryoneView: View {
    let props: EveryoneProps
    let sinks: EveryoneSinks

    var body: some View {
        VStack(spacing: 0) {
            header
            switch props.body {
            case .blank:
                Spacer()
            case .empty(let empty):
                EmptyListView(props: empty, send: sinks.empty)
            case .rows(let rows):
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(rows) { row in
                            AgentRowView(props: row, send: sinks.rows)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 24)
                }
            }
        }
        .background(Palette.background)
    }

    private var header: some View {
        HStack(spacing: 0) {
            Text("みんな")
                .font(.largeTitle.bold())
                .foregroundStyle(Palette.text)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button {
                sinks.header(.addAgentRequested)
            } label: {
                Image(systemName: "plus").frame(width: 44, height: 44)
            }
            .accessibilityLabel("エージェントを足す")
            Button {
                sinks.header(.appSettingsRequested)
            } label: {
                Image(systemName: "gearshape").frame(width: 44, height: 44)
            }
            .accessibilityLabel("アプリの設定")
        }
        .font(.title3)
        .tint(Palette.text)
        .padding(.leading, 20)
        .padding(.trailing, 8)
        .padding(.top, 8)
    }
}

/// One agent's row: her face, her name, what she is doing, the last thing said, when, and what is waiting.
struct AgentRowView: View {
    let props: AgentRowProps
    let send: EventSink

    var body: some View {
        Button {
            send(props.action)
        } label: {
            HStack(spacing: 12) {
                AvatarView(props: props.avatar, size: 52)
                VStack(alignment: .leading, spacing: 2) {
                    Text(props.name)
                        .font(.headline)
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                    StatusLineView(props: props.status)
                    Text(props.lastMessage)
                        .font(.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 6) {
                    Text(props.time)
                        .font(.caption)
                        .foregroundStyle(Palette.textSecondary)
                    HStack(spacing: 4) {
                        if let failures = props.failures { BadgeView(props: failures, fill: Palette.danger) }
                        if let unread = props.unread { BadgeView(props: unread, fill: Palette.accent) }
                    }
                }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 8)
            .frame(minHeight: 76)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Palette.border).frame(height: 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(props.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }
}

/// The mark and the words of an agent's state, in the state's colour.
struct StatusLineView: View {
    let props: StatusProps

    var body: some View {
        HStack(spacing: 6) {
            mark
            Text(props.text)
                .foregroundStyle(Palette.tone(props.tone))
                .fixedSize()
            if let detail = props.detail {
                Text(detail)
                    .font(.footnote.monospaced())
                    .foregroundStyle(Palette.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .font(.footnote)
    }

    @ViewBuilder private var mark: some View {
        switch props.mark {
        case .dot:
            Circle().fill(Palette.tone(props.tone)).frame(width: 8, height: 8)
        case .pause:
            Image(systemName: "pause.fill").font(.caption2).foregroundStyle(Palette.tone(props.tone))
        case .warning:
            Image(systemName: "exclamationmark.triangle").font(.caption2).foregroundStyle(Palette.tone(props.tone))
        }
    }
}

struct BadgeView: View {
    let props: BadgeProps
    let fill: Color

    var body: some View {
        Text(props.text)
            .font(.caption.bold())
            .foregroundStyle(Palette.onAccent)
            .padding(.horizontal, 6)
            .frame(minWidth: 20, minHeight: 20)
            .background(fill, in: Capsule())
            .accessibilityLabel(props.accessibilityLabel)
    }
}

/// An agent's face, round; her initial until the image shows, or when there is none.
struct AvatarView: View {
    let props: AvatarProps
    let size: CGFloat

    var body: some View {
        AsyncImage(url: props.url) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                Text(props.initial)
                    .font(.system(size: size * 0.4, weight: .semibold))
                    .foregroundStyle(Palette.textSecondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Palette.neutral)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}

/// What the list shows when no agent has been added.
struct EmptyListView: View {
    let props: EmptyListProps
    let send: EventSink

    var body: some View {
        VStack(spacing: 12) {
            Spacer()
            Text(props.title).font(.headline).foregroundStyle(Palette.text)
            Text(props.message)
                .font(.subheadline)
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
            PrimaryButton(props: props.action, send: send)
                .fixedSize()
                .padding(.top, 8)
            Spacer()
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity)
    }
}

/// The accent button.
struct PrimaryButton: View {
    let props: ActionProps
    let send: EventSink
    var busy = false

    var body: some View {
        Button {
            send(props.event)
        } label: {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(Palette.onAccent) }
                Text(props.label).font(.body.weight(.semibold))
            }
            .foregroundStyle(Palette.onAccent)
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Palette.accent, in: RoundedRectangle(cornerRadius: 10))
            .opacity(props.enabled || busy ? 1 : 0.4)
        }
        .disabled(!props.enabled)
    }
}

#Preview {
    EveryoneView(
        props: AppProps.root(AppState(agents: []), now: .now, calendar: .current).everyone, sinks: EveryoneSinks())
}
