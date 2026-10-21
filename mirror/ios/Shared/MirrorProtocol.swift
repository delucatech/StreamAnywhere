//
//  MirrorProtocol.swift
//  The Swift side of shared/mirror.ts ("mirror/1"): the binary framing the viewer decodes.
//
import Foundation

enum MirrorProtocol {
    static let name = "mirror/1"
    /// The phone's own web server on its hotspot: the viewer page on one port, the WebSocket on the next
    static let localPagePort: UInt16 = 8420
    static let localSocketPort: UInt16 = 8421
    /// WebRTC data channels cap one message; larger ones travel as CHUNKs
    static let chunkBytes = 60 * 1024

    enum MessageType: UInt8 {
        case config = 0x01
        case video = 0x02
        case audio = 0x03
        case chunk = 0x10
    }
    static let keyFlag: UInt8 = 0x01
}

struct MirrorVideoConfig: Codable, Equatable {
    var codec: String
    var width: Int
    var height: Int
    /// base64 AVCDecoderConfigurationRecord
    var description: String
    /// degrees clockwise the picture must be turned to be upright
    var rotation: Int
    var fps: Int
}

struct MirrorAudioConfig: Codable, Equatable {
    var codec: String
    var sampleRate: Int
    var channels: Int
    /// base64 AudioSpecificConfig
    var description: String
}

struct MirrorConfig: Codable, Equatable {
    var v: Int = 1
    var video: MirrorVideoConfig?
    var audio: MirrorAudioConfig?
    var name: String?
}

enum MirrorFraming {
    static func config(_ config: MirrorConfig) -> Data {
        var out = Data([MirrorProtocol.MessageType.config.rawValue])
        if let json = try? JSONEncoder().encode(config) { out.append(json) }
        return out
    }

    /// VIDEO / AUDIO: type, flags, f64 little-endian microseconds, payload
    static func frame(video: Bool, key: Bool, timestampUs: Double, payload: Data) -> Data {
        var out = Data(capacity: 10 + payload.count)
        out.append(video ? MirrorProtocol.MessageType.video.rawValue : MirrorProtocol.MessageType.audio.rawValue)
        out.append(key ? MirrorProtocol.keyFlag : 0)
        var bits = timestampUs.bitPattern.littleEndian
        withUnsafeBytes(of: &bits) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }

    static func isVideo(_ message: Data) -> Bool { message.first == MirrorProtocol.MessageType.video.rawValue }
    static func isKeyVideo(_ message: Data) -> Bool { message.count > 1 && isVideo(message) && (message[message.startIndex + 1] & MirrorProtocol.keyFlag) != 0 }

    /// Splits a message that is too big for a data channel into CHUNK messages (id u32, index u16, count u16, slice).
    static func chunks(_ message: Data, id: UInt32, max: Int = MirrorProtocol.chunkBytes) -> [Data] {
        if message.count <= max { return [message] }
        let count = (message.count + max - 1) / max
        var out: [Data] = []
        out.reserveCapacity(count)
        for i in 0..<count {
            let start = message.startIndex + i * max
            let end = min(message.endIndex, start + max)
            var c = Data(capacity: 9 + (end - start))
            c.append(MirrorProtocol.MessageType.chunk.rawValue)
            var idLE = id.littleEndian
            withUnsafeBytes(of: &idLE) { c.append(contentsOf: $0) }
            var idx = UInt16(i).littleEndian
            withUnsafeBytes(of: &idx) { c.append(contentsOf: $0) }
            var cnt = UInt16(count).littleEndian
            withUnsafeBytes(of: &cnt) { c.append(contentsOf: $0) }
            c.append(message[start..<end])
            out.append(c)
        }
        return out
    }

    /// avc1.PPCCLL from an SPS NAL unit (profile_idc, constraint flags, level_idc)
    static func avcCodecString(sps: Data) -> String {
        guard sps.count >= 4 else { return "avc1.42e01f" }
        let b = [UInt8](sps.prefix(4))
        return String(format: "avc1.%02x%02x%02x", b[1], b[2], b[3])
    }

    /// AVCDecoderConfigurationRecord for one SPS and one PPS, 4-byte NAL lengths
    static func avcC(sps: Data, pps: Data) -> Data {
        var out = Data()
        let s = [UInt8](sps)
        out.append(contentsOf: [1, s[1], s[2], s[3], 0xff, 0xe1, UInt8(sps.count >> 8), UInt8(sps.count & 0xff)])
        out.append(sps)
        out.append(contentsOf: [1, UInt8(pps.count >> 8), UInt8(pps.count & 0xff)])
        out.append(pps)
        return out
    }

    /// AudioSpecificConfig for AAC-LC
    static func aacAudioSpecificConfig(sampleRate: Int, channels: Int) -> Data {
        let rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
        let idx = rates.firstIndex(of: sampleRate) ?? 4
        let objectType = 2
        return Data([UInt8((objectType << 3) | (idx >> 1)), UInt8(((idx & 1) << 7) | (channels << 3))])
    }
}

/// JSON control messages (WebSocket text frames / data-channel strings): kept as dictionaries, the set is small.
enum MirrorControl {
    static func encode(_ dict: [String: Any]) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: dict), let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }
    static func decode(_ text: String) -> [String: Any]? {
        guard let d = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }
    static func hello(name: String) -> String { encode(["t": "hello", "name": name, "protocol": MirrorProtocol.name]) }
}

/// Six characters from the alphabet without 0/O/1/I (the server's rooms; also made here when offline)
enum RoomCode {
    static let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
    static func random() -> String { String((0..<6).map { _ in alphabet.randomElement()! }) }
    static func isValid(_ s: String) -> Bool { s.count == 6 && s.allSatisfy { alphabet.contains($0) } }
}
