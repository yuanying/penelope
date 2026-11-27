import Foundation
import Security

/// Each deployment's token, in the Keychain, one item per origin (ADR-0064). The token never leaves the Keychain
/// except to be sent to the origin it was issued by.
struct TokenKeychain: Sendable {
    private let service = "penelope.app-token"

    private func query(_ origin: URL) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: origin.absoluteString,
        ]
    }

    func read(_ origin: URL) -> String? {
        var query = query(origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    /// Keeps the token, over any kept before for the same origin.
    @discardableResult
    func write(_ token: String, for origin: URL) -> Bool {
        delete(origin)
        var item = query(origin)
        item[kSecValueData as String] = Data(token.utf8)
        // Readable after the first unlock, so that a notification can be read in the background (I7), and never
        // carried to another device in a backup.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    func delete(_ origin: URL) {
        SecItemDelete(query(origin) as CFDictionary)
    }
}
