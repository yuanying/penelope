import Foundation

/// The iPhone's sign-in to one deployment, as far as it is words on the wire (docs/ui-api.md「iPhone のログインと端末の
/// 失効」). Making the PKCE verifier and its challenge needs a random source and SHA-256, so the app does that.
public enum AppLogin {
    /// The scheme the backend sends the code back on.
    public static let callbackScheme = "penelope"

    /// Where the sign-in is opened.
    public static func startURL(origin: URL, challenge: String) -> URL {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.path = "/auth/app/start"
        components.queryItems = [
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        return components.url!
    }

    /// The one-time code in the URL the sign-in ended on, or nil when it is not the backend's answer.
    public static func code(from callback: URL) -> String? {
        guard callback.scheme == callbackScheme, callback.host == "auth",
            let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        return items.first { $0.name == "code" }?.value.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The body of `POST /auth/app/token`.
    public static func tokenRequest(code: String, verifier: String, deviceName: String) -> Data {
        let trimmed = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
            .filter { !$0.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) } }
        let name = trimmed.isEmpty ? "iPhone" : String(trimmed.prefix(100))
        let body = ["code": code, "code_verifier": verifier, "device_name": name]
        return try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }

    /// The token in the answer of `POST /auth/app/token`.
    public static func token(from data: Data) -> String? {
        struct Wire: Decodable { var token: String }
        return (try? JSONDecoder().decode(Wire.self, from: data))?.token
    }
}

/// The address of a deployment, from what the owner typed: the origin of its Web UI.
public enum AgentAddress {
    /// The origin of the typed URL. The scheme may be left out and is then HTTPS; only HTTPS is taken, since the token
    /// is sent only there. A path, a query or a fragment is dropped.
    public static func origin(of typed: String) -> URL? {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let withScheme = text.contains("://") ? text : "https://" + text
        guard let parsed = URLComponents(string: withScheme), parsed.scheme?.lowercased() == "https",
            let host = parsed.host, !host.isEmpty
        else { return nil }
        var origin = URLComponents()
        origin.scheme = "https"
        origin.host = host.lowercased()
        origin.port = parsed.port == 443 ? nil : parsed.port
        return origin.url
    }
}
