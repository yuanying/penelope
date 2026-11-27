/// One server-sent event: its name and its data.
public struct ServerSentEvent: Equatable, Sendable {
    public var event: String
    public var data: String

    public init(event: String, data: String) {
        self.event = event
        self.data = data
    }
}

/// Puts server-sent events together from the lines of a stream, as the HTML standard reads them. The app reads the
/// lines off the connection; this only knows what they mean.
public struct ServerSentEventReader: Sendable {
    private var event = ""
    private var data: [String] = []

    public init() {}

    /// Takes one line, without its line break. Returns an event when the line ended one.
    public mutating func feed(line: String) -> ServerSentEvent? {
        if line.isEmpty {
            defer {
                event = ""
                data = []
            }
            guard !data.isEmpty else { return nil }
            return ServerSentEvent(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value))
        default: break  // id and retry are not used by the summary stream
        }
        return nil
    }
}
