// The C# side of shared/mirror.ts ("mirror/1"): the binary framing the viewer page decodes, the
// control messages, the room codes. Compiled into the broadcast extension and (linked) into the app.
using System.Text;
using System.Text.Json;

namespace StreamAnywhere.Mirror;

public static class MirrorProtocol
{
    public const string Name = "mirror/1";
    /// <summary>The phone's own web server on its hotspot: the viewer page on one port, the WebSocket on the next.</summary>
    public const int LocalPagePort = 8420;
    public const int LocalSocketPort = 8421;
    public const string HotspotAddress = "172.20.10.1";

    public const byte Config = 0x01;
    public const byte Video = 0x02;
    public const byte Audio = 0x03;
    public const byte KeyFlag = 0x01;

    /// <summary>CONFIG: type byte + UTF-8 JSON.</summary>
    public static byte[] ConfigMessage(string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        var outp = new byte[1 + body.Length];
        outp[0] = Config;
        Buffer.BlockCopy(body, 0, outp, 1, body.Length);
        return outp;
    }

    /// <summary>VIDEO / AUDIO: type, flags, f64 little-endian microseconds, payload.</summary>
    public static byte[] FrameMessage(bool video, bool key, double timestampUs, ReadOnlySpan<byte> payload)
    {
        var outp = new byte[10 + payload.Length];
        outp[0] = video ? Video : Audio;
        outp[1] = key ? KeyFlag : (byte)0;
        BitConverter.TryWriteBytes(outp.AsSpan(2, 8), timestampUs);
        if (!BitConverter.IsLittleEndian) outp.AsSpan(2, 8).Reverse();
        payload.CopyTo(outp.AsSpan(10));
        return outp;
    }

    public static bool IsVideo(byte[] m) => m.Length > 1 && m[0] == Video;
    public static bool IsKeyVideo(byte[] m) => IsVideo(m) && (m[1] & KeyFlag) != 0;

    /// <summary>avc1.PPCCLL from an SPS NAL unit.</summary>
    public static string AvcCodecString(byte[] sps) => sps.Length >= 4 ? $"avc1.{sps[1]:x2}{sps[2]:x2}{sps[3]:x2}" : "avc1.42e01f";

    /// <summary>AVCDecoderConfigurationRecord for one SPS and one PPS, 4-byte NAL lengths.</summary>
    public static byte[] AvcC(byte[] sps, byte[] pps)
    {
        var outp = new byte[11 + sps.Length + pps.Length];
        outp[0] = 1;
        outp[1] = sps[1];
        outp[2] = sps[2];
        outp[3] = sps[3];
        outp[4] = 0xff;
        outp[5] = 0xe1;
        outp[6] = (byte)(sps.Length >> 8);
        outp[7] = (byte)(sps.Length & 0xff);
        Buffer.BlockCopy(sps, 0, outp, 8, sps.Length);
        var o = 8 + sps.Length;
        outp[o++] = 1;
        outp[o++] = (byte)(pps.Length >> 8);
        outp[o++] = (byte)(pps.Length & 0xff);
        Buffer.BlockCopy(pps, 0, outp, o, pps.Length);
        return outp;
    }

    /// <summary>AudioSpecificConfig for AAC-LC.</summary>
    public static byte[] AacAudioSpecificConfig(int sampleRate, int channels)
    {
        int[] rates = { 96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350 };
        var idx = Array.IndexOf(rates, sampleRate);
        if (idx < 0) idx = 4;
        const int objectType = 2;
        return new[] { (byte)((objectType << 3) | (idx >> 1)), (byte)(((idx & 1) << 7) | (channels << 3)) };
    }

    /// <summary>The CONFIG JSON the viewer expects (MirrorConfig in shared/mirror.ts).</summary>
    public static string ConfigJson(string name, string? videoCodec, int width, int height, byte[]? avcC, int rotation, int fps, int? audioSampleRate, int audioChannels, byte[]? asc)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteNumber("v", 1);
            if (videoCodec != null && avcC != null)
            {
                w.WriteStartObject("video");
                w.WriteString("codec", videoCodec);
                w.WriteNumber("width", width);
                w.WriteNumber("height", height);
                w.WriteString("description", Convert.ToBase64String(avcC));
                w.WriteNumber("rotation", rotation);
                w.WriteNumber("fps", fps);
                w.WriteEndObject();
            }
            if (audioSampleRate != null && asc != null)
            {
                w.WriteStartObject("audio");
                w.WriteString("codec", "mp4a.40.2");
                w.WriteNumber("sampleRate", audioSampleRate.Value);
                w.WriteNumber("channels", audioChannels);
                w.WriteString("description", Convert.ToBase64String(asc));
                w.WriteEndObject();
            }
            w.WriteString("name", name);
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }
}

/// <summary>JSON control messages (WebSocket text frames): the few the sender sends and reads.</summary>
public static class MirrorControl
{
    public static string Hello(string name) => $"{{\"t\":\"hello\",\"name\":{JsonSerializer.Serialize(name)},\"protocol\":\"{MirrorProtocol.Name}\"}}";
    public static string Pong => "{\"t\":\"pong\"}";
    public static string Ping => "{\"t\":\"ping\"}";

    /// <summary>The "t" of a control message, or null when it is not one.</summary>
    public static string? TypeOf(string text, out JsonElement root)
    {
        root = default;
        try
        {
            using var doc = JsonDocument.Parse(text);
            root = doc.RootElement.Clone();
            return root.TryGetProperty("t", out var t) ? t.GetString() : null;
        }
        catch
        {
            return null;
        }
    }
}

/// <summary>Six characters from the alphabet without 0/O/1/I (the server's rooms; also made here when offline).</summary>
public static class RoomCode
{
    public const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    public static string Random()
    {
        var chars = new char[6];
        for (var i = 0; i < chars.Length; i++) chars[i] = Alphabet[System.Security.Cryptography.RandomNumberGenerator.GetInt32(Alphabet.Length)];
        return new string(chars);
    }
    public static bool IsValid(string? s) => s != null && s.Length == 6 && s.All(c => Alphabet.Contains(c));
}
