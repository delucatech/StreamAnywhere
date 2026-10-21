//
//  SampleHandler.swift
//  The Broadcast Upload Extension: iOS calls this with the screen's frames and the app's sound
//  once the user starts the broadcast (from the Mirror app, or Control Center's screen recording
//  button with "Mirror" chosen). Everything else is the Broadcaster.
//
import ReplayKit

final class SampleHandler: RPBroadcastSampleHandler {
    private let broadcaster = Broadcaster()
    private var paused = false

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        broadcaster.onFatal = { [weak self] message in
            let error = NSError(domain: "com.delucatech.mirror", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
            self?.finishBroadcastWithError(error)
        }
        broadcaster.start()
    }

    override func broadcastPaused() {
        paused = true
    }

    override func broadcastResumed() {
        paused = false
    }

    override func broadcastFinished() {
        broadcaster.stop()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard !paused else { return }
        switch sampleBufferType {
        case .video:
            broadcaster.video(sampleBuffer)
        case .audioApp:
            broadcaster.audio(sampleBuffer)
        case .audioMic:
            if MirrorSettings.load().microphone { broadcaster.audio(sampleBuffer) }
        @unknown default:
            break
        }
    }
}
