//
//  DirectLinks.swift
//  The "internet direct" way: a WebRTC data channel to each watcher that offers one. The offer and
//  the ICE candidates travel through the relay's control messages ("signal"); once the channel is
//  open the frames go straight to the car and the relay stops copying them.
//
//  Needs the WebRTC package (project.yml: https://github.com/stasel/WebRTC). Without it the app
//  still builds and the direct link is simply never made.
//
import Foundation

#if canImport(WebRTC)
import WebRTC

final class DirectLinks: NSObject {
    private let factory: RTCPeerConnectionFactory
    private let queue: DispatchQueue
    private var iceServers: [RTCIceServer] = []
    private var links: [String: Link] = [:]
    private var chunkId: UInt32 = 1
    var name = "iPhone"
    var onNeedKey: (() -> Void)?
    var onSignal: ((String, [String: Any]) -> Void)?
    var onCountChanged: ((Int) -> Void)?
    var onLog: ((String) -> Void)?
    var count: Int { links.values.filter { $0.channel?.readyState == .open }.count }

    private let highWater: UInt64 = 2 * 1024 * 1024

    private final class Link: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
        let id: String
        var pc: RTCPeerConnection?
        var channel: RTCDataChannel?
        var skipping = true
        var pending: [RTCIceCandidate] = []
        weak var owner: DirectLinks?
        init(id: String, owner: DirectLinks) {
            self.id = id
            self.owner = owner
        }

        func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
        func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
            if newState == .failed || newState == .closed { owner?.queue.async { self.owner?.drop(self.id) } }
        }
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
            owner?.queue.async {
                self.owner?.onSignal?(self.id, ["candidate": ["candidate": candidate.sdp, "sdpMid": candidate.sdpMid as Any, "sdpMLineIndex": Int(candidate.sdpMLineIndex)]])
            }
        }
        func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
            owner?.queue.async {
                self.channel = dataChannel
                dataChannel.delegate = self
                if dataChannel.readyState == .open { self.opened() }
            }
        }
        func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
            owner?.queue.async {
                if dataChannel.readyState == .open { self.opened() } else if dataChannel.readyState == .closed { self.owner?.drop(self.id) }
            }
        }
        func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
            guard !buffer.isBinary, let s = String(data: buffer.data, encoding: .utf8), let msg = MirrorControl.decode(s) else { return }
            if msg["t"] as? String == "need-key" { owner?.queue.async { self.skipping = true; self.owner?.onNeedKey?() } }
        }
        private func opened() {
            guard let owner else { return }
            owner.onLog?("direct link \(id) open")
            channel?.sendData(RTCDataBuffer(data: Data(MirrorControl.hello(name: owner.name).utf8), isBinary: false))
            if let cfg = owner.lastConfig { channel?.sendData(RTCDataBuffer(data: cfg, isBinary: true)) }
            skipping = true
            owner.onNeedKey?()
            owner.onCountChanged?(owner.count)
        }
    }

    private(set) var lastConfig: Data?

    init(queue: DispatchQueue) {
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory(encoderFactory: nil, decoderFactory: nil)
        self.queue = queue
        super.init()
    }

    func configure(iceServers: [IceServer]) {
        self.iceServers = iceServers.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
    }

    /// A "signal" control message from a watcher (through the relay): an offer or a candidate.
    func handleSignal(from watcher: String, data: [String: Any]) {
        if let sdp = data["sdp"] as? [String: Any], sdp["type"] as? String == "offer", let text = sdp["sdp"] as? String {
            drop(watcher)
            let link = Link(id: watcher, owner: self)
            let cfg = RTCConfiguration()
            cfg.iceServers = iceServers
            cfg.sdpSemantics = .unifiedPlan
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            guard let pc = factory.peerConnection(with: cfg, constraints: constraints, delegate: link) else { return }
            link.pc = pc
            links[watcher] = link
            pc.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: text)) { [weak self, weak link] error in
                guard let self, let link else { return }
                self.queue.async {
                    if let error {
                        self.onLog?("direct link \(watcher): \(error.localizedDescription)")
                        self.drop(watcher)
                        return
                    }
                    for c in link.pending { pc.add(c) { _ in } }
                    link.pending = []
                    pc.answer(for: constraints) { answer, error in
                        self.queue.async {
                            guard let answer, error == nil else {
                                self.onLog?("direct link \(watcher): answer failed")
                                self.drop(watcher)
                                return
                            }
                            pc.setLocalDescription(answer) { _ in }
                            self.onSignal?(watcher, ["sdp": ["type": "answer", "sdp": answer.sdp]])
                        }
                    }
                }
            }
            return
        }
        if let cand = data["candidate"] as? [String: Any], let sdp = cand["candidate"] as? String, let link = links[watcher] {
            let c = RTCIceCandidate(sdp: sdp, sdpMLineIndex: Int32((cand["sdpMLineIndex"] as? Int) ?? 0), sdpMid: cand["sdpMid"] as? String)
            if link.pc?.remoteDescription != nil { link.pc?.add(c) { _ in } } else { link.pending.append(c) }
        }
    }

    func drop(_ watcher: String) {
        guard let link = links.removeValue(forKey: watcher) else { return }
        link.channel?.close()
        link.pc?.close()
        onCountChanged?(count)
    }

    func broadcast(config: Data) {
        lastConfig = config
        for l in links.values where l.channel?.readyState == .open { l.channel?.sendData(RTCDataBuffer(data: config, isBinary: true)) }
    }

    func broadcast(frame: Data, isVideo: Bool, key: Bool) {
        var wantKey = false
        for l in links.values {
            guard let ch = l.channel, ch.readyState == .open else { continue }
            if l.skipping {
                if isVideo && key && ch.bufferedAmount < highWater / 4 { l.skipping = false } else { wantKey = true; continue }
            } else if ch.bufferedAmount > highWater {
                l.skipping = true
                wantKey = true
                continue
            }
            let id = chunkId
            chunkId &+= 1
            for piece in MirrorFraming.chunks(frame, id: id) { ch.sendData(RTCDataBuffer(data: piece, isBinary: true)) }
        }
        if wantKey { onNeedKey?() }
    }

    func closeAll() {
        for id in Array(links.keys) { drop(id) }
    }
}

#else

/// The WebRTC package is not part of the build: no direct links, everything else works.
final class DirectLinks {
    var name = "iPhone"
    var onNeedKey: (() -> Void)?
    var onSignal: ((String, [String: Any]) -> Void)?
    var onCountChanged: ((Int) -> Void)?
    var onLog: ((String) -> Void)?
    var count: Int { 0 }
    init(queue: DispatchQueue) {}
    func configure(iceServers: [IceServer]) {}
    func handleSignal(from watcher: String, data: [String: Any]) {}
    func drop(_ watcher: String) {}
    func broadcast(config: Data) {}
    func broadcast(frame: Data, isVideo: Bool, key: Bool) {}
    func closeAll() {}
}

#endif
