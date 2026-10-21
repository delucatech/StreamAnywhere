//
//  AACEncoder.swift
//  AudioToolbox AAC-LC: the app's sound (whatever PCM layout ReplayKit hands over) becomes raw AAC
//  frames of 1024 samples on a continuous timeline. The viewer that plays through MSE waits for both
//  tracks, so the Broadcaster feeds silence through here whenever the app is quiet.
//
import Foundation
import AudioToolbox
import CoreMedia

final class AACEncoder {
    let sampleRate: Int
    let channels: Int
    private var converter: AudioConverterRef?
    private var inputFormat: AudioStreamBasicDescription
    private var outputFormat: AudioStreamBasicDescription
    /// Interleaved Int16 PCM waiting to be encoded (the converter's input format)
    private var pcm = Data()
    private let scratch: UnsafeMutableRawPointer
    private let scratchCapacity = 64 * 1024
    private let outBuffer: UnsafeMutableRawPointer
    private let outCapacity = 16 * 1024
    private var packetsOut: Int64 = 0
    private var framesIn: Int64 = 0
    /// Microseconds of the first sample fed (the stream's timeline); -1 until something was fed
    private(set) var startUs: Double = -1
    private(set) var lastRealAudioAt: Double = 0
    var onPacket: ((Data, Double) -> Void)?
    var onError: ((String) -> Void)?

    /// The decoder configuration every viewer needs: known before any sound was heard.
    var audioSpecificConfig: Data { MirrorFraming.aacAudioSpecificConfig(sampleRate: sampleRate, channels: channels) }

    init?(sampleRate: Int = 44100, channels: Int = 2, bitrate: UInt32 = 128_000) {
        self.sampleRate = sampleRate
        self.channels = channels
        inputFormat = AudioStreamBasicDescription(mSampleRate: Double(sampleRate), mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked, mBytesPerPacket: UInt32(2 * channels), mFramesPerPacket: 1, mBytesPerFrame: UInt32(2 * channels), mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 16, mReserved: 0)
        outputFormat = AudioStreamBasicDescription(mSampleRate: Double(sampleRate), mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0, mBytesPerPacket: 0, mFramesPerPacket: 1024, mBytesPerFrame: 0, mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 0, mReserved: 0)
        scratch = UnsafeMutableRawPointer.allocate(byteCount: scratchCapacity, alignment: 16)
        outBuffer = UnsafeMutableRawPointer.allocate(byteCount: outCapacity, alignment: 16)
        var c: AudioConverterRef?
        guard AudioConverterNew(&inputFormat, &outputFormat, &c) == noErr, let c else {
            scratch.deallocate()
            outBuffer.deallocate()
            return nil
        }
        converter = c
        var rate = bitrate
        AudioConverterSetProperty(c, kAudioConverterEncodeBitRate, UInt32(MemoryLayout<UInt32>.size), &rate)
    }

    deinit {
        if let converter { AudioConverterDispose(converter) }
        scratch.deallocate()
        outBuffer.deallocate()
    }

    /// Where the timeline is, in microseconds since startUs, counted in samples fed.
    var fedUs: Double { startUs < 0 ? 0 : startUs + Double(framesIn) / Double(sampleRate) * 1e6 }

    /// The app's own sound: converted to the input layout and resampled by sample-dropping/doubling
    /// only when the rates differ (ReplayKit delivers 44.1 kHz; anything else is rare).
    func append(sampleBuffer sb: CMSampleBuffer, timestampUs: Double) {
        guard let fmt = CMSampleBufferGetFormatDescription(sb), let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee else { return }
        let frames = CMSampleBufferGetNumSamples(sb)
        guard frames > 0 else { return }
        var interleaved = Data()
        if !Self.readPCM(sb, asbd: asbd, frames: frames, channelsOut: channels, into: &interleaved) { return }
        if Int(asbd.mSampleRate) != sampleRate {
            interleaved = Self.resample(interleaved, from: Int(asbd.mSampleRate), to: sampleRate, channels: channels)
        }
        lastRealAudioAt = timestampUs
        align(to: timestampUs)
        feed(interleaved)
    }

    /// Silence up to `untilUs` on the timeline (the app is quiet, the track must not stop).
    func appendSilence(untilUs: Double) {
        if startUs < 0 { startUs = untilUs }
        let want = Int((untilUs - fedUs) * Double(sampleRate) / 1e6)
        guard want > 0 else { return }
        let n = min(want, sampleRate * 2)
        feed(Data(count: n * 2 * channels))
    }

    /// Keeps the sample-counted timeline on the real clock: a gap gets silence, an overlap is let be.
    private func align(to timestampUs: Double) {
        if startUs < 0 {
            startUs = timestampUs
            return
        }
        let ahead = timestampUs - fedUs
        if ahead > 120_000 { appendSilence(untilUs: timestampUs) }
    }

    private func feed(_ data: Data) {
        pcm.append(data)
        framesIn += Int64(data.count / (2 * channels))
        drain()
    }

    private var framesPending: Int { pcm.count / (2 * channels) }

    private func drain() {
        guard let converter else { return }
        while framesPending >= 1024 {
            var packets: UInt32 = 1
            var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: UInt32(channels), mDataByteSize: UInt32(outCapacity), mData: outBuffer))
            var desc = AudioStreamPacketDescription()
            let status = AudioConverterFillComplexBuffer(converter, Self.inputProc, Unmanaged.passUnretained(self).toOpaque(), &packets, &list, &desc)
            if status != noErr && status != Self.noMoreData {
                onError?("AAC encode failed (\(status))")
                return
            }
            if packets == 0 { return }
            let bytes = Int(list.mBuffers.mDataByteSize)
            let packet = Data(bytes: outBuffer, count: bytes)
            let ts = startUs + Double(packetsOut) * 1024.0 / Double(sampleRate) * 1e6
            packetsOut += 1
            onPacket?(packet, ts)
        }
    }

    private static let noMoreData: OSStatus = -1

    private static let inputProc: AudioConverterComplexInputDataProc = { _, ioNumberDataPackets, ioData, _, inUserData in
        guard let userData = inUserData else { return noMoreData }
        let enc = Unmanaged<AACEncoder>.fromOpaque(userData).takeUnretainedValue()
        return enc.provide(ioNumberDataPackets, ioData)
    }

    private func provide(_ ioNumberDataPackets: UnsafeMutablePointer<UInt32>, _ ioData: UnsafeMutablePointer<AudioBufferList>) -> OSStatus {
        let bytesPerFrame = 2 * channels
        let available = framesPending
        if available == 0 {
            ioNumberDataPackets.pointee = 0
            return Self.noMoreData
        }
        let give = min(Int(ioNumberDataPackets.pointee), available, scratchCapacity / bytesPerFrame)
        let bytes = give * bytesPerFrame
        pcm.withUnsafeBytes { raw in
            if let base = raw.baseAddress { scratch.copyMemory(from: base, byteCount: bytes) }
        }
        pcm.removeFirst(bytes)
        ioData.pointee.mNumberBuffers = 1
        ioData.pointee.mBuffers.mNumberChannels = UInt32(channels)
        ioData.pointee.mBuffers.mDataByteSize = UInt32(bytes)
        ioData.pointee.mBuffers.mData = scratch
        ioNumberDataPackets.pointee = UInt32(give)
        return noErr
    }

    // MARK: - PCM reading (Int16 / Float32, interleaved or planar, any channel count -> Int16 interleaved)

    private static func readPCM(_ sb: CMSampleBuffer, asbd: AudioStreamBasicDescription, frames: Int, channelsOut: Int, into out: inout Data) -> Bool {
        var blockBuffer: CMBlockBuffer?
        let channelsIn = Int(asbd.mChannelsPerFrame)
        let planar = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let bits = Int(asbd.mBitsPerChannel)
        guard bits == 16 || (isFloat && bits == 32) else { return false }
        let bufferCount = planar ? channelsIn : 1
        let listSize = MemoryLayout<AudioBufferList>.size + (bufferCount - 1) * MemoryLayout<AudioBuffer>.size
        let listPtr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
        defer { listPtr.deallocate() }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: listSize, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &blockBuffer)
        guard status == noErr else { return false }
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        out = Data(count: frames * 2 * channelsOut)
        out.withUnsafeMutableBytes { dst in
            let d = dst.bindMemory(to: Int16.self)
            for f in 0..<frames {
                for c in 0..<channelsOut {
                    let srcChannel = min(c, channelsIn - 1)
                    var sample: Int16 = 0
                    if planar {
                        guard srcChannel < buffers.count, let p = buffers[srcChannel].mData else { continue }
                        sample = isFloat ? Self.toInt16(p.bindMemory(to: Float.self, capacity: frames)[f]) : p.bindMemory(to: Int16.self, capacity: frames)[f]
                    } else {
                        guard let p = buffers[0].mData else { continue }
                        let i = f * channelsIn + srcChannel
                        sample = isFloat ? Self.toInt16(p.bindMemory(to: Float.self, capacity: frames * channelsIn)[i]) : p.bindMemory(to: Int16.self, capacity: frames * channelsIn)[i]
                    }
                    d[f * channelsOut + c] = sample
                }
            }
        }
        return true
    }

    private static func toInt16(_ v: Float) -> Int16 {
        let c = max(-1, min(1, v))
        return Int16(c * 32767)
    }

    /// Nearest-sample resampling: only for the rare source that is not at the stream's rate.
    private static func resample(_ pcm: Data, from: Int, to: Int, channels: Int) -> Data {
        let framesIn = pcm.count / (2 * channels)
        let framesOut = Int(Double(framesIn) * Double(to) / Double(from))
        var out = Data(count: framesOut * 2 * channels)
        pcm.withUnsafeBytes { src in
            let s = src.bindMemory(to: Int16.self)
            out.withUnsafeMutableBytes { dst in
                let d = dst.bindMemory(to: Int16.self)
                for f in 0..<framesOut {
                    let sf = min(framesIn - 1, Int(Double(f) * Double(from) / Double(to)))
                    for c in 0..<channels { d[f * channels + c] = s[sf * channels + c] }
                }
            }
        }
        return out
    }
}
