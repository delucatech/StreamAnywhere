// VideoToolbox H.264: the screen's pixel buffers (scaled down first) become AVCC access units with
// the SPS/PPS handed out separately, exactly what the viewer's decoder configuration wants.
using CoreMedia;
using CoreVideo;
using Foundation;
using VideoToolbox;

namespace StreamAnywhere.Broadcast;

public sealed class H264Encoder : IDisposable
{
    public int Width { get; }
    public int Height { get; }
    readonly int fps;
    readonly int bitrate;
    VTCompressionSession? session;
    VTPixelTransferSession? transfer;
    CVPixelBufferPool? pool;
    byte[]? lastSps;
    byte[]? lastPps;
    readonly NSDictionary forceKeyOptions;

    /// <summary>The SPS/PPS of the stream (before the first keyframe that uses them, and again if they change)</summary>
    public Action<byte[], byte[]>? OnParameterSets;
    /// <summary>One encoded access unit (AVCC, 4-byte NAL lengths), keyframe?, its presentation time</summary>
    public Action<byte[], bool, CMTime>? OnEncoded;
    public Action<string>? OnError;

    public H264Encoder(int width, int height, int fps, int bitrate)
    {
        Width = width;
        Height = height;
        this.fps = fps;
        this.bitrate = bitrate;
        forceKeyOptions = new VTEncodeFrameOptions { ForceKeyFrame = true }.Dictionary;
        session = VTCompressionSession.Create(width, height, CMVideoCodecType.H264, Callback, null, (CVPixelBufferAttributes?)null);
        if (session == null) throw new InvalidOperationException("VTCompressionSession could not be created");
        session.SetCompressionProperties(new VTCompressionProperties
        {
            RealTime = true,
            ProfileLevel = VTProfileLevel.H264HighAutoLevel,
            AllowFrameReordering = false,
            MaxKeyFrameInterval = fps * 2,
            MaxKeyFrameIntervalDuration = 2,
            AverageBitRate = bitrate,
            ExpectedFrameRate = fps,
            H264EntropyMode = VTH264EntropyMode.Cabac,
        });
        session.PrepareToEncodeFrames();
    }

    /// <summary>Scales and encodes one picture. forceKey asks for an IDR frame (a watcher joined).</summary>
    public void Encode(CVPixelBuffer pixelBuffer, CMTime presentationTime, bool forceKey)
    {
        var s = session;
        if (s == null) return;
        using var scaled = Scaled(pixelBuffer);
        var source = scaled ?? pixelBuffer;
        var status = s.EncodeFrame(source, presentationTime, CMTime.Invalid, forceKey ? forceKeyOptions : null, IntPtr.Zero, out _);
        if (status != VTStatus.Ok) OnError?.Invoke($"encode call failed ({status})");
    }

    void Callback(IntPtr sourceFrame, VTStatus status, VTEncodeInfoFlags flags, CMSampleBuffer? sb)
    {
        if (status != VTStatus.Ok)
        {
            OnError?.Invoke($"encode failed ({status})");
            return;
        }
        if (sb == null) return;
        try
        {
            Handle(sb);
        }
        catch (Exception e)
        {
            OnError?.Invoke("encoder output: " + e.Message);
        }
    }

    void Handle(CMSampleBuffer sb)
    {
        if (!sb.DataIsReady) return;
        using var block = sb.GetDataBuffer();
        if (block == null) return;
        var attachments = sb.GetSampleAttachments(false);
        var notSync = attachments != null && attachments.Length > 0 && attachments[0].NotSync == true;
        var key = !notSync;
        var nalLength = 4;
        if (key)
        {
            using var fmt = sb.GetVideoFormatDescription();
            if (fmt != null)
            {
                var sps = fmt.GetH264ParameterSet(0, out _, out nalLength, out _);
                var pps = fmt.GetH264ParameterSet(1, out _, out _, out _);
                if (sps != null && pps != null && (lastSps == null || !sps.AsSpan().SequenceEqual(lastSps) || !pps.AsSpan().SequenceEqual(lastPps)))
                {
                    lastSps = sps;
                    lastPps = pps;
                    OnParameterSets?.Invoke(sps, pps);
                }
            }
        }
        var length = (int)block.DataLength;
        var data = new byte[length];
        unsafe
        {
            fixed (byte* p = data)
            {
                var err = block.CopyDataBytes(0, (nuint)length, (IntPtr)p);
                if (err != CMBlockBufferError.None) return;
            }
        }
        if (nalLength != 4) data = Relength(data, nalLength);
        OnEncoded?.Invoke(data, key, sb.PresentationTimeStamp);
    }

    /// <summary>Rewrites NAL length prefixes to 4 bytes (VideoToolbox uses 4 already; kept for safety).</summary>
    static byte[] Relength(byte[] data, int size)
    {
        using var ms = new MemoryStream(data.Length + 16);
        var i = 0;
        while (i + size <= data.Length)
        {
            var len = 0;
            for (var k = 0; k < size; k++) len = (len << 8) | data[i + k];
            i += size;
            if (i + len > data.Length) break;
            ms.WriteByte((byte)((len >> 24) & 0xff));
            ms.WriteByte((byte)((len >> 16) & 0xff));
            ms.WriteByte((byte)((len >> 8) & 0xff));
            ms.WriteByte((byte)(len & 0xff));
            ms.Write(data, i, len);
            i += len;
        }
        return ms.ToArray();
    }

    /// <summary>The screen buffer scaled to the session's size (null when it already fits).</summary>
    CVPixelBuffer? Scaled(CVPixelBuffer src)
    {
        if ((int)src.Width == Width && (int)src.Height == Height) return null;
        if (transfer == null)
        {
            transfer = VTPixelTransferSession.Create();
            if (transfer == null) return null;
            transfer.SetTransferProperties(new VTPixelTransferProperties { ScalingMode = VTScalingMode.Letterbox });
        }
        pool ??= new CVPixelBufferPool(new CVPixelBufferPoolSettings { MinimumBufferCount = 3 }, new CVPixelBufferAttributes(CVPixelFormatType.CV420YpCbCr8BiPlanarVideoRange, Width, Height));
        var dst = pool.CreatePixelBuffer();
        if (dst == null) return null;
        if (transfer.TransferImage(src, dst) != VTStatus.Ok)
        {
            dst.Dispose();
            return null;
        }
        return dst;
    }

    /// <summary>Output size for a source whose longest side must not exceed longSide (both even).</summary>
    public static (int, int) OutputSize(int w, int h, int longSide)
    {
        var scale = Math.Min(1.0, (double)longSide / Math.Max(w, h));
        var ow = Math.Max(2, (int)Math.Round(w * scale / 2) * 2);
        var oh = Math.Max(2, (int)Math.Round(h * scale / 2) * 2);
        return (ow, oh);
    }

    public void Dispose()
    {
        var s = session;
        session = null;
        if (s != null)
        {
            s.CompleteFrames(CMTime.Invalid);
            s.Dispose();
        }
        transfer?.Dispose();
        transfer = null;
        pool?.Dispose();
        pool = null;
    }
}
