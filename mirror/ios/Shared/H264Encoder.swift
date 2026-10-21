//
//  H264Encoder.swift
//  VideoToolbox H.264: the screen's pixel buffers (scaled down first) become AVCC access units
//  with the SPS/PPS handed out separately, exactly what the viewer's decoder configuration wants.
//
import Foundation
import CoreMedia
import CoreVideo
import VideoToolbox

final class H264Encoder {
    struct ParameterSets: Equatable {
        let sps: Data
        let pps: Data
    }

    let width: Int32
    let height: Int32
    let fps: Int
    let bitrate: Int
    private var session: VTCompressionSession?
    private var transfer: VTPixelTransferSession?
    private var pool: CVPixelBufferPool?
    private var parameterSets: ParameterSets?
    private let queue = DispatchQueue(label: "mirror.h264")

    /// The SPS/PPS of the stream (called before the first keyframe that uses them, and again if they change)
    var onParameterSets: ((ParameterSets) -> Void)?
    /// One encoded access unit (AVCC, 4-byte NAL lengths), whether it is a keyframe, its presentation time
    var onEncoded: ((Data, Bool, CMTime) -> Void)?
    var onError: ((String) -> Void)?
    private(set) var framesIn = 0
    private(set) var framesOut = 0

    init?(width: Int32, height: Int32, fps: Int, bitrate: Int) {
        self.width = width
        self.height = height
        self.fps = fps
        self.bitrate = bitrate
        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: nil, width: width, height: height, codecType: kCMVideoCodecType_H264, encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        guard status == noErr, let session = s else { return nil }
        self.session = session
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (fps * 2) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 2 as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: [bitrate / 8 * 3 / 2, 1] as CFArray)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_H264EntropyMode, value: kVTH264EntropyMode_CABAC)
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    /// Scales and encodes one picture. `forceKey` asks for an IDR frame (a watcher joined).
    func encode(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime, forceKey: Bool) {
        guard let session else { return }
        framesIn += 1
        let source = scaled(pixelBuffer) ?? pixelBuffer
        var props: [CFString: Any] = [:]
        if forceKey { props[kVTEncodeFrameOptionKey_ForceKeyFrame] = true }
        var flags = VTEncodeInfoFlags()
        let status = VTCompressionSessionEncodeFrameWithOutputHandler(session, imageBuffer: source, presentationTimeStamp: presentationTime, duration: .invalid, frameProperties: props.isEmpty ? nil : props as CFDictionary, infoFlagsOut: &flags) { [weak self] status, _, sampleBuffer in
            guard let self else { return }
            if status != noErr {
                self.onError?("encode failed (\(status))")
                return
            }
            if let sb = sampleBuffer { self.handle(sb) }
        }
        if status != noErr { onError?("encode call failed (\(status))") }
    }

    private func handle(_ sb: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sb), let block = CMSampleBufferGetDataBuffer(sb) else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]]
        let notSync = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
        let key = !notSync
        var nalLength: Int32 = 4
        if key, let fmt = CMSampleBufferGetFormatDescription(sb) {
            var spsPtr: UnsafePointer<UInt8>?
            var spsSize = 0
            var ppsPtr: UnsafePointer<UInt8>?
            var ppsSize = 0
            var count = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &nalLength) == noErr,
               CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 1, parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
               let sp = spsPtr, let pp = ppsPtr {
                let sets = ParameterSets(sps: Data(bytes: sp, count: spsSize), pps: Data(bytes: pp, count: ppsSize))
                if sets != parameterSets {
                    parameterSets = sets
                    onParameterSets?(sets)
                }
            }
        }
        let length = CMBlockBufferGetDataLength(block)
        var data = Data(count: length)
        let copied = data.withUnsafeMutableBytes { raw -> OSStatus in
            guard let base = raw.baseAddress else { return -1 }
            return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base)
        }
        guard copied == noErr else { return }
        if nalLength != 4 { data = Self.relength(data, from: Int(nalLength)) }
        framesOut += 1
        onEncoded?(data, key, CMSampleBufferGetPresentationTimeStamp(sb))
    }

    /// Rewrites NAL length prefixes to 4 bytes (VideoToolbox uses 4 already; kept for safety).
    private static func relength(_ data: Data, from size: Int) -> Data {
        var out = Data(capacity: data.count + 16)
        var i = data.startIndex
        while i + size <= data.endIndex {
            var len = 0
            for k in 0..<size { len = (len << 8) | Int(data[i + k]) }
            i += size
            guard i + len <= data.endIndex else { break }
            out.append(contentsOf: [UInt8((len >> 24) & 0xff), UInt8((len >> 16) & 0xff), UInt8((len >> 8) & 0xff), UInt8(len & 0xff)])
            out.append(data[i..<(i + len)])
            i += len
        }
        return out
    }

    /// The screen buffer scaled to the session's size (nil when it already fits).
    private func scaled(_ src: CVPixelBuffer) -> CVPixelBuffer? {
        if CVPixelBufferGetWidth(src) == Int(width) && CVPixelBufferGetHeight(src) == Int(height) { return nil }
        if transfer == nil {
            var t: VTPixelTransferSession?
            guard VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &t) == noErr, let t else { return nil }
            VTSessionSetProperty(t, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Letterbox)
            transfer = t
        }
        if pool == nil {
            let attrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey: Int(width),
                kCVPixelBufferHeightKey: Int(height),
                kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            ]
            var p: CVPixelBufferPool?
            CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey: 3] as CFDictionary, attrs as CFDictionary, &p)
            pool = p
        }
        guard let transfer, let pool else { return nil }
        var dst: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &dst) == noErr, let dst else { return nil }
        guard VTPixelTransferSessionTransferImage(transfer, from: src, to: dst) == noErr else { return nil }
        return dst
    }

    func invalidate() {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        if let transfer { VTPixelTransferSessionInvalidate(transfer) }
        transfer = nil
        pool = nil
    }

    deinit { invalidate() }

    /// Output size for a source of `w`×`h` whose longest side must not exceed `longSide` (both even).
    static func outputSize(width w: Int, height h: Int, longSide: Int) -> (Int32, Int32) {
        let scale = min(1.0, Double(longSide) / Double(max(w, h)))
        let ow = max(2, Int((Double(w) * scale / 2).rounded()) * 2)
        let oh = max(2, Int((Double(h) * scale / 2).rounded()) * 2)
        return (Int32(ow), Int32(oh))
    }
}
