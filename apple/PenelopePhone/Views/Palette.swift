import PenelopeCore
import SwiftUI
import UIKit

/// The colours of the design guide's chapter 9 (the neutral theme), light and dark.
enum Palette {
    static let background = dynamic(0xf1f1f1ff, 0x1b1b1bff)
    static let surface = dynamic(0xffffffff, 0x262626ff)
    static let text = dynamic(0x000000ff, 0xffffffff)
    static let textSecondary = dynamic(0x474747ff, 0x9e9e9eff)
    static let border = dynamic(0x00000014, 0xffffff1a)
    static let neutral = dynamic(0x0000000f, 0xffffff1a)
    static let accent = dynamic(0x1b1b1bff, 0xf1f1f1ff)
    static let onAccent = dynamic(0xffffffff, 0x111111ff)
    static let info = dynamic(0x0067ceff, 0xa1caffff)
    static let onWarningMuted = dynamic(0x4b3900ff, 0xeec448ff)
    /// The failures' badge and a field in the wrong, as in the guide's mock.
    static let danger = dynamic(0xc9303aff, 0xff705dff)

    static func tone(_ tone: StatusProps.Tone) -> Color {
        switch tone {
        case .info: info
        case .muted: textSecondary
        case .warning: onWarningMuted
        }
    }

    /// A colour of `0xRRGGBBAA` in light mode and another in dark mode.
    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(
            uiColor: UIColor { traits in
                let value = traits.userInterfaceStyle == .dark ? dark : light
                return UIColor(
                    red: CGFloat((value >> 24) & 0xff) / 255, green: CGFloat((value >> 16) & 0xff) / 255,
                    blue: CGFloat((value >> 8) & 0xff) / 255, alpha: CGFloat(value & 0xff) / 255)
            })
    }
}
