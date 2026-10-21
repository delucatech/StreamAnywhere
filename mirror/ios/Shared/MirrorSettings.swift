//
//  MirrorSettings.swift
//  What the app configures and the broadcast extension reads: kept in the App Group, since the two
//  are separate processes. The extension writes its status next to it for the app to show.
//
import Foundation

enum MirrorQuality: String, CaseIterable, Codable, Identifiable {
    case data = "data"       // 854 long side, 1.5 Mb/s - the car's LTE
    case balanced = "balanced" // 1280, 3 Mb/s
    case sharp = "sharp"     // 1920, 6 Mb/s - the hotspot / Wi-Fi

    var id: String { rawValue }
    var label: String {
        switch self {
        case .data: return "Saver (480p, 1.5 Mb/s)"
        case .balanced: return "Balanced (720p, 3 Mb/s)"
        case .sharp: return "Sharp (1080p, 6 Mb/s)"
        }
    }
    var longSide: Int {
        switch self {
        case .data: return 854
        case .balanced: return 1280
        case .sharp: return 1920
        }
    }
    var bitrate: Int {
        switch self {
        case .data: return 1_500_000
        case .balanced: return 3_000_000
        case .sharp: return 6_000_000
        }
    }
}

struct MirrorSettings: Codable, Equatable {
    /// The App Group both targets belong to (project.yml / the entitlements)
    static let appGroup = "group.com.delucatech.mirror"
    static let broadcastExtensionBundleId = "com.delucatech.mirror.broadcast"

    var serverURL: String = "https://teslavplayer.duckdns.org"
    var deviceName: String = ""
    var room: String = ""
    var roomCreatedAt: Date?
    var quality: MirrorQuality = .balanced
    var fps: Int = 30
    var audio: Bool = true
    var microphone: Bool = false
    /// Use the StreamAnywhere relay / signalling at all (off = hotspot only)
    var useServer: Bool = true
    var useDirectLink: Bool = true
    var signedIn: Bool = false

    static var defaults: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }
    private static let key = "mirror.settings"

    static func load() -> MirrorSettings {
        if let d = defaults.data(forKey: key), let s = try? JSONDecoder().decode(MirrorSettings.self, from: d) { return s }
        var s = MirrorSettings()
        s.deviceName = Self.defaultDeviceName()
        return s
    }

    func save() {
        if let d = try? JSONEncoder().encode(self) { Self.defaults.set(d, forKey: Self.key) }
    }

    static func defaultDeviceName() -> String {
        #if canImport(UIKit)
        return "iPhone"
        #else
        return "iPhone"
        #endif
    }

    /// Cookies (the site password's sa_auth) shared by the app and the extension
    static var cookieStorage: HTTPCookieStorage { HTTPCookieStorage.sharedCookieStorage(forGroupContainerIdentifier: appGroup) }

    /// The login cookie as a Cookie header value, if signed in
    static func cookieHeader(for server: URL) -> String? {
        let cookies = cookieStorage.cookies(for: server) ?? []
        guard !cookies.isEmpty else { return nil }
        return cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    }

    var server: URL? { URL(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines)) }
}

/// What the extension is doing, for the app's screen (written once a second to the group container).
struct MirrorStatus: Codable {
    var state: String = "idle"        // idle | starting | live | stopped | error
    var message: String = ""
    var room: String = ""
    var updatedAt: Date = Date()
    var videoFrames: Int = 0
    var kbps: Int = 0
    var width: Int = 0
    var height: Int = 0
    var rotation: Int = 0
    var relay: String = "off"        // off | connecting | open | idle (nobody needs the relay)
    var watchers: Int = 0
    var localClients: Int = 0
    var directLinks: Int = 0
    var localAddresses: [String] = []

    static var file: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: MirrorSettings.appGroup)?.appendingPathComponent("status.json")
    }
    func write() {
        guard let f = Self.file, let d = try? JSONEncoder().encode(self) else { return }
        try? d.write(to: f, options: .atomic)
    }
    static func read() -> MirrorStatus? {
        guard let f = file, let d = try? Data(contentsOf: f) else { return nil }
        return try? JSONDecoder().decode(MirrorStatus.self, from: d)
    }
}
