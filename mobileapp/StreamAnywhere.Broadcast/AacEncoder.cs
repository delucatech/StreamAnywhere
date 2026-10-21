// AudioToolbox AAC-LC: the app's sound (whatever PCM layout ReplayKit hands over) becomes raw AAC
// frames of 1024 samples on a continuous timeline. The viewer that plays through MSE waits for both
// tracks, so the Broadcaster feeds silence through here whenever the app is quiet.
using System.Runtime.InteropServices;
using AudioToolbox;
using CoreMedia;
using StreamAnywhere.Mirror;

namespace StreamAnywhere.Broadcast;

public sealed class AacEncoder : IDisposable
{
    public int SampleRate { get; }
    public int Channels { get; }
    AudioConverter? converter;
    /// <summary>Interleaved Int16 PCM waiting to be encoded (the converter's input format)</summary>
    readonly List<byte> pcm = new();
    readonly IntPtr scratch;
    const int ScratchCapacity = 64 * 1024;
    readonly IntPtr outBuffer;
    const int OutCapacity = 16 * 1024;
    long packetsOut;
    long framesIn;
    /// <summary>Microseconds of the first sample fed (the stream's timeline); -1 until something was fed</summary>
    public double StartUs { get; private set; } = -1;
    public double LastRealAudioAt { get; private set; }
    public Action<byte[], double>? OnPacket;
    public Action<string>? OnError;

    /// <summary>The decoder configuration every viewer needs: known before any sound was heard.</summary>
    public byte[] AudioSpecificConfig => MirrorProtocol.AacAudioSpecificConfig(SampleRate, Channels);

    public AacEncoder(int sampleRate = 44100, int channels = 2, int bitrate = 128_000)
    {
        SampleRate = sampleRate;
        Channels = channels;
        var input = new AudioStreamBasicDescription
        {
            SampleRate = sampleRate,
            Format = AudioFormatType.LinearPCM,
            FormatFlags = AudioFormatFlags.IsSignedInteger | AudioFormatFlags.IsPacked,
            BytesPerPacket = 2 * channels,
            FramesPerPacket = 1,
            BytesPerFrame = 2 * channels,
            ChannelsPerFrame = channels,
            BitsPerChannel = 16,
        };
        var output = new AudioStreamBasicDescription
        {
            SampleRate = sampleRate,
            Format = AudioFormatType.MPEG4AAC,
            FramesPerPacket = 1024,
            ChannelsPerFrame = channels,
        };
        scratch = Marshal.AllocHGlobal(ScratchCapacity);
        outBuffer = Marshal.AllocHGlobal(OutCapacity);
        converter = AudioConverter.Create(input, output, out var err);
        if (converter == null || err != AudioConverterError.None)
        {
            Marshal.FreeHGlobal(scratch);
            Marshal.FreeHGlobal(outBuffer);
            throw new InvalidOperationException($"AAC converter: {err}");
        }
        converter.EncodeBitRate = (uint)bitrate;
        converter.InputData += Provide;
    }

    /// <summary>Where the timeline is, in microseconds, counted in samples fed.</summary>
    public double FedUs => StartUs < 0 ? 0 : StartUs + framesIn / (double)SampleRate * 1e6;

    /// <summary>The app's own sound: converted to the input layout (and crudely resampled only when the rate differs).</summary>
    public void Append(CMSampleBuffer sb, double timestampUs)
    {
        using var fmt = sb.GetAudioFormatDescription();
        var asbd = fmt?.AudioStreamBasicDescription;
        if (asbd == null) return;
        var frames = (int)sb.NumSamples;
        if (frames <= 0) return;
        var interleaved = ReadPcm(sb, asbd.Value, frames);
        if (interleaved == null) return;
        if ((int)asbd.Value.SampleRate != SampleRate) interleaved = Resample(interleaved, (int)asbd.Value.SampleRate, SampleRate, Channels);
        LastRealAudioAt = timestampUs;
        Align(timestampUs);
        Feed(interleaved);
    }

    /// <summary>Silence up to untilUs on the timeline (the app is quiet, the track must not stop).</summary>
    public void AppendSilence(double untilUs)
    {
        if (StartUs < 0) StartUs = untilUs;
        var want = (int)((untilUs - FedUs) * SampleRate / 1e6);
        if (want <= 0) return;
        var n = Math.Min(want, SampleRate * 2);
        Feed(new byte[n * 2 * Channels]);
    }

    void Align(double timestampUs)
    {
        if (StartUs < 0)
        {
            StartUs = timestampUs;
            return;
        }
        if (timestampUs - FedUs > 120_000) AppendSilence(timestampUs);
    }

    void Feed(byte[] data)
    {
        pcm.AddRange(data);
        framesIn += data.Length / (2 * Channels);
        Drain();
    }

    int FramesPending => pcm.Count / (2 * Channels);

    void Drain()
    {
        var c = converter;
        if (c == null) return;
        while (FramesPending >= 1024)
        {
            var packets = 1;
            using var buffers = new AudioBuffers(1);
            buffers.SetData(0, outBuffer, OutCapacity);
            buffers[0] = new AudioBuffer { NumberChannels = Channels, DataByteSize = OutCapacity, Data = outBuffer };
            var descs = new AudioStreamPacketDescription[1];
            var err = c.FillComplexBuffer(ref packets, buffers, descs);
            if (err != AudioConverterError.None && (int)err != NoMoreData)
            {
                OnError?.Invoke($"AAC encode failed ({err})");
                return;
            }
            if (packets == 0) return;
            var bytes = buffers[0].DataByteSize;
            var packet = new byte[bytes];
            Marshal.Copy(outBuffer, packet, 0, bytes);
            var ts = StartUs + packetsOut * 1024.0 / SampleRate * 1e6;
            packetsOut++;
            OnPacket?.Invoke(packet, ts);
        }
    }

    const int NoMoreData = -1;

    AudioConverterError Provide(ref int numberDataPackets, AudioBuffers data, ref AudioStreamPacketDescription[] dataPacketDescription)
    {
        var bytesPerFrame = 2 * Channels;
        var available = FramesPending;
        if (available == 0)
        {
            numberDataPackets = 0;
            return (AudioConverterError)NoMoreData;
        }
        var give = Math.Min(Math.Min(numberDataPackets, available), ScratchCapacity / bytesPerFrame);
        var bytes = give * bytesPerFrame;
        var chunk = pcm.GetRange(0, bytes).ToArray();
        pcm.RemoveRange(0, bytes);
        Marshal.Copy(chunk, 0, scratch, bytes);
        data[0] = new AudioBuffer { NumberChannels = Channels, DataByteSize = bytes, Data = scratch };
        numberDataPackets = give;
        return AudioConverterError.None;
    }

    // ---- PCM reading (Int16 / Float32, interleaved or planar, any channel count -> Int16 interleaved)

    byte[]? ReadPcm(CMSampleBuffer sb, AudioStreamBasicDescription asbd, int frames)
    {
        using var block = sb.GetDataBuffer();
        if (block == null) return null;
        var channelsIn = asbd.ChannelsPerFrame;
        var planar = (asbd.FormatFlags & AudioFormatFlags.IsNonInterleaved) != 0;
        var isFloat = (asbd.FormatFlags & AudioFormatFlags.IsFloat) != 0;
        var bits = asbd.BitsPerChannel;
        if (!(bits == 16 || (isFloat && bits == 32))) return null;
        var bytesPerSample = bits / 8;
        var total = (int)block.DataLength;
        var raw = new byte[total];
        unsafe
        {
            fixed (byte* p = raw)
            {
                if (block.CopyDataBytes(0, (nuint)total, (IntPtr)p) != CMBlockBufferError.None) return null;
            }
        }
        // planar: the block holds channel 0's samples, then channel 1's, …; interleaved: sample by sample
        var outp = new byte[frames * 2 * Channels];
        var planeBytes = frames * bytesPerSample;
        for (var f = 0; f < frames; f++)
        {
            for (var c = 0; c < Channels; c++)
            {
                var src = Math.Min(c, channelsIn - 1);
                var offset = planar ? src * planeBytes + f * bytesPerSample : (f * channelsIn + src) * bytesPerSample;
                short sample = 0;
                if (offset + bytesPerSample <= raw.Length)
                {
                    if (isFloat)
                    {
                        var v = BitConverter.ToSingle(raw, offset);
                        sample = (short)(Math.Clamp(v, -1f, 1f) * 32767);
                    }
                    else sample = BitConverter.ToInt16(raw, offset);
                }
                var o = (f * Channels + c) * 2;
                outp[o] = (byte)(sample & 0xff);
                outp[o + 1] = (byte)((sample >> 8) & 0xff);
            }
        }
        return outp;
    }

    /// <summary>Nearest-sample resampling: only for the rare source that is not at the stream's rate.</summary>
    static byte[] Resample(byte[] pcm, int from, int to, int channels)
    {
        var framesIn = pcm.Length / (2 * channels);
        var framesOut = (int)((long)framesIn * to / from);
        var outp = new byte[framesOut * 2 * channels];
        for (var f = 0; f < framesOut; f++)
        {
            var sf = Math.Min(framesIn - 1, (int)((long)f * from / to));
            Buffer.BlockCopy(pcm, sf * 2 * channels, outp, f * 2 * channels, 2 * channels);
        }
        return outp;
    }

    public void Dispose()
    {
        var c = converter;
        converter = null;
        if (c != null)
        {
            c.InputData -= Provide;
            c.Dispose();
        }
        Marshal.FreeHGlobal(scratch);
        Marshal.FreeHGlobal(outBuffer);
    }
}
