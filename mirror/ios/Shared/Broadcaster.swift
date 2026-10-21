//
//  Broadcaster.swift
//  The heart of the broadcast extension: ReplayKit's screen and sound in, the three links out.
//
//   screen CMSampleBuffers -> H264Encoder (scaled, capped frame rate) ─┐
//   app audio CMSampleBuffers / silence -> AACEncoder ─────────────────┼─> CONFIG + VIDEO/AUDIO messages
//                                                                      │     -> RelayClient (the server)
//                                                                      │     -> LocalServer (the hotspot)
//                                                                      └     -> DirectLinks (WebRTC)
//
//  Everything runs on one serial queue. The extension has ~50 MB: no copies kept beyond the GOP the
//  links are sending, frames skipped (not queued) when something is behind.
//
import Foundation
import CoreMedia
import CoreVideo
import ImageIO
import ReplayKit

final class Broadcaster {
    let queue = DispatchQueue(label: "mirror.broadcaster", qos: .userInitiated)
    private var settings = MirrorSettings.load()
    private var epoch: CMTime?
    private var encoder: H264Encoder?
    private var aac: AACEncoder?
    private var relay: RelayClient?
    private var local: LocalServer?
    private var direct: DirectLinks?
    private var videoConfig: MirrorVideoConfig?
    private var audioConfig: MirrorAudioConfig?
    private var configData: Data?
    private var parameterSets: H264Encoder.ParameterSets?
    private var forceKey = true
    private var relayDemand = true
    private var rotation = 0
    private var lastEncodedUs: Double = -1
    private var queuedVideo = 0
    private let queuedLock = NSLock()
    private var bytesThisSecond = 0
    private var status = MirrorStatus()
    private var statusTimer: DispatchSourceTimer?
    private var silenceTimer: DispatchSourceTimer?
    private var stopped = false
    var onFatal: ((String) -> Void)?

    // MARK: - lifecycle

    func start() {
        queue.async { self.startOnQueue() }
    }

    private func startOnQueue() {
        settings = MirrorSettings.load()
        if settings.room.isEmpty || !RoomCode.isValid(settings.room) {
            settings.room = RoomCode.random()
            settings.save()
        }
        status.state = "starting"
        status.room = settings.room
        status.localAddresses = LocalServer.localIPv4Addresses()
        status.write()

        if settings.audio, let a = AACEncoder(sampleRate: 44100, channels: 2) {
            a.onPacket = { [weak self] packet, ts in self?.emit(MirrorFraming.frame(video: false, key: true, timestampUs: ts, payload: packet), isVideo: false, key: true) }
            a.onError = { [weak self] m in self?.log(m) }
            aac = a
            audioConfig = MirrorAudioConfig(codec: "mp4a.40.2", sampleRate: 44100, channels: 2, description: a.audioSpecificConfig.base64EncodedString())
        }

        let l = LocalServer(queue: queue)
        l.name = settings.deviceName
        l.onNeedKey = { [weak self] in self?.forceKey = true }
        l.onClientJoined = { [weak self] in
            guard let self else { return }
            if let c = self.configData { self.local?.broadcast(config: c) }
            self.forceKey = true
        }
        l.onClientsChanged = { [weak self] n in self?.status.localClients = n }
        l.onLog = { [weak self] m in self?.log(m) }
        l.start()
        local = l

        if settings.useServer, let server = settings.server {
            let api = ServerAPI(server: server)
            if settings.useDirectLink { direct = makeDirectLinks(api: api) }

            let r = RelayClient(server: server, room: settings.room, name: settings.deviceName, cookie: MirrorSettings.cookieHeader(for: server), queue: queue)
            r.onState = { [weak self] st in
                guard let self else { return }
                self.status.relay = st == .open && !self.relayDemand ? "idle" : st.rawValue
                if st == .open, let c = self.configData { r.send(config: c) }
                if st == .open { self.forceKey = true }
            }
            r.onNeedKey = { [weak self] in self?.forceKey = true }
            r.onControl = { [weak self] msg in self?.handleRelayControl(msg) }
            r.connect()
            relay = r
        } else {
            status.relay = "off"
        }

        let st = DispatchSource.makeTimerSource(queue: queue)
        st.schedule(deadline: .now() + 1, repeating: 1)
        st.setEventHandler { [weak self] in self?.tickStatus() }
        st.resume()
        statusTimer = st

        if aac != nil {
            let sil = DispatchSource.makeTimerSource(queue: queue)
            sil.schedule(deadline: .now() + 0.05, repeating: 0.05)
            sil.setEventHandler { [weak self] in self?.tickSilence() }
            sil.resume()
            silenceTimer = sil
        }
        status.state = "live"
        status.write()
    }

    private func makeDirectLinks(api: ServerAPI) -> DirectLinks {
        let d = DirectLinks(queue: queue)
        d.name = settings.deviceName
        d.onNeedKey = { [weak self] in self?.forceKey = true }
        d.onCountChanged = { [weak self] n in self?.status.directLinks = n }
        d.onLog = { [weak self] m in self?.log(m) }
        d.onSignal = { [weak self] watcher, data in self?.relay?.send(control: ["t": "signal", "to": watcher, "data": data]) }
        Task { [weak self] in
            let ice = await api.iceServers()
            self?.queue.async { self?.direct?.configure(iceServers: ice) }
        }
        return d
    }

    func stop() {
        queue.sync {
            stopped = true
            statusTimer?.cancel()
            silenceTimer?.cancel()
            relay?.close()
            local?.stop()
            direct?.closeAll()
            encoder?.invalidate()
            encoder = nil
            aac = nil
            status.state = "stopped"
            status.message = ""
            status.write()
        }
    }

    private func log(_ m: String) {
        status.message = m
        NSLog("[Mirror] %@", m)
    }

    // MARK: - relay control

    private func handleRelayControl(_ msg: [String: Any]) {
        switch msg["t"] as? String {
        case "need-key":
            forceKey = true
        case "ready":
            status.watchers = msg["watchers"] as? Int ?? 0
        case "watcher":
            status.watchers = msg["watchers"] as? Int ?? status.watchers
            if msg["event"] as? String == "leave", let id = msg["id"] as? String { direct?.drop(id) }
        case "relay-demand":
            relayDemand = msg["on"] as? Bool ?? true
            status.relay = relayDemand ? "open" : "idle"
            if relayDemand { forceKey = true }
        case "signal":
            if let from = msg["from"] as? String, let data = msg["data"] as? [String: Any] { direct?.handleSignal(from: from, data: data) }
        default:
            break
        }
    }

    // MARK: - samples in

    /// ReplayKit's thread: the buffer is handed to the queue unless it is already behind.
    func video(_ sb: CMSampleBuffer) {
        queuedLock.lock()
        if queuedVideo > 1 {
            queuedLock.unlock()
            return
        }
        queuedVideo += 1
        queuedLock.unlock()
        queue.async {
            self.queuedLock.lock()
            self.queuedVideo -= 1
            self.queuedLock.unlock()
            self.encodeVideo(sb)
        }
    }

    func audio(_ sb: CMSampleBuffer) {
        guard aac != nil else { return }
        queue.async { self.encodeAudio(sb) }
    }

    private func relativeUs(_ t: CMTime) -> Double {
        if epoch == nil { epoch = t }
        return max(0, CMTimeSubtract(t, epoch!).seconds * 1e6)
    }

    private func encodeVideo(_ sb: CMSampleBuffer) {
        guard !stopped, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        let us = relativeUs(pts)
        let minGap = 1e6 / Double(settings.fps) * 0.85
        if lastEncodedUs >= 0 && us - lastEncodedUs < minGap { return }

        let rot = Self.rotation(of: sb)
        if rot != rotation {
            rotation = rot
            if videoConfig != nil {
                videoConfig?.rotation = rot
                publishConfig()
                forceKey = true
            }
        }

        let w = CVPixelBufferGetWidth(pb)
        let h = CVPixelBufferGetHeight(pb)
        let (ow, oh) = H264Encoder.outputSize(width: w, height: h, longSide: settings.quality.longSide)
        if encoder == nil || encoder!.width != ow || encoder!.height != oh {
            encoder?.invalidate()
            guard let e = H264Encoder(width: ow, height: oh, fps: settings.fps, bitrate: settings.quality.bitrate) else {
                onFatal?("The video encoder could not be started.")
                return
            }
            e.onParameterSets = { [weak self] sets in self?.parameterSetsChanged(sets, width: Int(ow), height: Int(oh)) }
            e.onEncoded = { [weak self] data, key, time in self?.encoded(data, key: key, time: time) }
            e.onError = { [weak self] m in self?.log(m) }
            encoder = e
            forceKey = true
        }
        let key = forceKey
        forceKey = false
        lastEncodedUs = us
        encoder?.encode(pb, presentationTime: pts, forceKey: key)
    }

    private func parameterSetsChanged(_ sets: H264Encoder.ParameterSets, width: Int, height: Int) {
        parameterSets = sets
        videoConfig = MirrorVideoConfig(codec: MirrorFraming.avcCodecString(sps: sets.sps), width: width, height: height, description: MirrorFraming.avcC(sps: sets.sps, pps: sets.pps).base64EncodedString(), rotation: rotation, fps: settings.fps)
        status.width = width
        status.height = height
        publishConfig()
    }

    private func publishConfig() {
        guard let v = videoConfig else { return }
        let config = MirrorConfig(v: 1, video: v, audio: audioConfig, name: settings.deviceName)
        let data = MirrorFraming.config(config)
        configData = data
        relay?.send(config: data)
        local?.broadcast(config: data)
        direct?.broadcast(config: data)
    }

    private func encoded(_ data: Data, key: Bool, time: CMTime) {
        guard configData != nil else { return }
        let us = relativeUs(time)
        status.videoFrames += 1
        status.rotation = rotation
        emit(MirrorFraming.frame(video: true, key: key, timestampUs: us, payload: data), isVideo: true, key: key)
    }

    private func encodeAudio(_ sb: CMSampleBuffer) {
        guard !stopped, let aac else { return }
        let us = relativeUs(CMSampleBufferGetPresentationTimeStamp(sb))
        aac.append(sampleBuffer: sb, timestampUs: us)
    }

    /// The viewer that plays through MSE waits for both tracks: when the app is quiet, silence keeps the sound track going.
    private func tickSilence() {
        guard !stopped, let aac, let epoch, configData != nil else { return }
        let nowUs = max(0, CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), epoch).seconds * 1e6)
        if nowUs - aac.lastRealAudioAt > 150_000 { aac.appendSilence(untilUs: nowUs - 100_000) }
    }

    // MARK: - frames out

    private func emit(_ message: Data, isVideo: Bool, key: Bool) {
        bytesThisSecond += message.count
        if relayDemand { relay?.send(frame: message, isVideo: isVideo, key: key) }
        local?.broadcast(frame: message, isVideo: isVideo, key: key)
        direct?.broadcast(frame: message, isVideo: isVideo, key: key)
    }

    private func tickStatus() {
        status.kbps = bytesThisSecond * 8 / 1000
        bytesThisSecond = 0
        status.updatedAt = Date()
        status.localAddresses = LocalServer.localIPv4Addresses()
        status.write()
    }

    /// ReplayKit marks each frame with the screen's orientation; the viewer turns the picture (0/90/180/270 clockwise).
    private static func rotation(of sb: CMSampleBuffer) -> Int {
        guard let raw = CMGetAttachment(sb, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber, let o = CGImagePropertyOrientation(rawValue: raw.uint32Value) else { return 0 }
        switch o {
        case .up, .upMirrored: return 0
        case .right, .rightMirrored: return 90
        case .down, .downMirrored: return 180
        case .left, .leftMirrored: return 270
        @unknown default: return 0
        }
    }
}
