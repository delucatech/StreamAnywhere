// The heart of the broadcast extension: ReplayKit's screen and sound in, the links out.
//
//   screen CMSampleBuffers -> H264Encoder (scaled, capped frame rate) ─┐
//   app audio CMSampleBuffers / silence -> AacEncoder ─────────────────┼─> CONFIG + VIDEO/AUDIO messages
//                                                                      │     -> RelayClient (the server)
//                                                                      └     -> LocalServer (the hotspot)
//
// Everything runs on one serial queue. The extension has ~50 MB: no copies kept beyond what the links
// are sending, frames skipped (not queued) when something is behind. The WebRTC direct link of the
// Swift version (mirror/ios) is not here: there is no .NET WebRTC binding small enough for the limit;
// the relay and the hotspot page cover the two other ways.
using CoreMedia;
using CoreVideo;
using Foundation;
using StreamAnywhere.Mirror;

namespace StreamAnywhere.Broadcast;

public sealed class Broadcaster
{
    readonly SerialQueue queue = new SerialQueue("mirror.broadcaster");
    MirrorSettings settings = MirrorSettings.Load();
    CMTime? epoch;
    H264Encoder? encoder;
    AacEncoder? aac;
    RelayClient? relay;
    LocalServer? local;
    string? videoCodec;
    byte[]? avcC;
    int videoWidth, videoHeight;
    byte[]? configData;
    bool forceKey = true;
    bool relayDemand = true;
    int rotation;
    double lastEncodedUs = -1;
    int queuedVideo;
    long bytesThisSecond;
    readonly MirrorStatus status = new();
    Timer? statusTimer;
    Timer? silenceTimer;
    bool stopped;
    public Action<string>? OnFatal;

    // ---- lifecycle

    public void Start() => queue.Post(StartOnQueue);

    void StartOnQueue()
    {
        MirrorSignals.Post(MirrorSignals.Alive);
        if (!MirrorStatus.ContainerAvailable) MirrorSignals.Post(MirrorSignals.NoGroup);
        settings = MirrorSettings.Load();
        if (!RoomCode.IsValid(settings.Room))
        {
            settings.Room = RoomCode.Random();
            settings.Save();
        }
        status.State = "starting";
        status.Room = settings.Room;
        status.LocalAddresses = LocalAddresses.IPv4();
        status.Write();

        if (settings.Audio)
        {
            try
            {
                var a = new AacEncoder(44100, 2);
                a.OnPacket = (packet, ts) => Emit(MirrorProtocol.FrameMessage(false, true, ts, packet), false, true);
                a.OnError = Log;
                aac = a;
            }
            catch (Exception e)
            {
                Log("no AAC encoder: " + e.Message);
            }
        }

        // The server link first: it is the way the Tesla usually watches, and nothing the hotspot server
        // does (or fails to do) may keep it from connecting.
        if (settings.UseServer && settings.Server is { } server)
        {
            if (settings.Cookie.Length == 0) status.RelayError = "not signed in to the server: pair with the Tesla first";
            var r = new RelayClient(server, settings.Room, settings.DeviceName, settings.Cookie, queue);
            r.OnState = st =>
            {
                status.Relay = st == RelayClient.LinkState.Open && !relayDemand ? "idle" : st.ToString().ToLowerInvariant();
                if (st == RelayClient.LinkState.Open)
                {
                    status.RelayError = "";
                    if (configData != null) r.SendConfig(configData);
                    forceKey = true;
                }
                status.Write();
            };
            r.OnNeedKey = () => forceKey = true;
            r.OnControl = HandleRelayControl;
            r.OnError = why =>
            {
                status.RelayError = why;
                Console.WriteLine("[Mirror] relay: " + why);
                status.Write();
                MirrorSignals.Post(MirrorSignals.RelayError);
            };
            r.Connect();
            relay = r;
        }
        else status.Relay = "off";

        // the hotspot page and its WebSocket; a port in use or a refused listener is a note, not the end
        try
        {
            var l = new LocalServer(queue) { Name = settings.DeviceName };
            l.OnNeedKey = () => forceKey = true;
            l.OnClientJoined = () =>
            {
                if (configData != null) local?.Broadcast(configData);
                forceKey = true;
            };
            l.OnClientsChanged = n => status.LocalClients = n;
            l.OnLog = Log;
            l.Start();
            local = l;
        }
        catch (Exception e)
        {
            Log("hotspot server: " + e.Message);
        }

        statusTimer = new Timer(_ => queue.Post(TickStatus), null, 1000, 1000);
        if (aac != null) silenceTimer = new Timer(_ => queue.Post(TickSilence), null, 50, 50);
        status.State = "live";
        status.Write();
    }

    /// <summary>The broadcast cannot go on: the status says why (the app shows it), then iOS is told.</summary>
    void Fatal(string message)
    {
        status.State = "error";
        status.Message = message;
        status.Write();
        OnFatal?.Invoke(message);
    }

    public void Stop()
    {
        queue.Run(() =>
        {
            if (stopped) return;
            stopped = true;
            statusTimer?.Dispose();
            silenceTimer?.Dispose();
            relay?.Close();
            local?.Stop();
            encoder?.Dispose();
            encoder = null;
            aac?.Dispose();
            aac = null;
            // an error stays on the status for the app to show; a plain stop clears the notes
            if (status.State != "error")
            {
                status.State = "stopped";
                status.Message = "";
            }
            status.Write();
        });
        queue.Stop();
    }

    void Log(string m)
    {
        status.Message = m;
        Console.WriteLine("[Mirror] " + m);
    }

    // ---- relay control

    void HandleRelayControl(string t, System.Text.Json.JsonElement msg)
    {
        switch (t)
        {
            case "need-key":
                forceKey = true;
                break;
            case "ready":
                status.Watchers = msg.TryGetProperty("watchers", out var w) ? w.GetInt32() : 0;
                break;
            case "watcher":
                if (msg.TryGetProperty("watchers", out var n)) status.Watchers = n.GetInt32();
                break;
            case "relay-demand":
                relayDemand = !msg.TryGetProperty("on", out var on) || on.GetBoolean();
                status.Relay = relayDemand ? "open" : "idle";
                if (relayDemand) forceKey = true;
                break;
        }
    }

    // ---- samples in (ReplayKit's thread)

    public void Video(CMSampleBuffer sb)
    {
        if (Interlocked.CompareExchange(ref queuedVideo, 0, 0) > 1 || queue.Pending > 8)
        {
            sb.Dispose();
            return;
        }
        Interlocked.Increment(ref queuedVideo);
        queue.Post(() =>
        {
            Interlocked.Decrement(ref queuedVideo);
            try
            {
                EncodeVideo(sb);
            }
            finally
            {
                sb.Dispose();
            }
        });
    }

    public void Audio(CMSampleBuffer sb)
    {
        if (aac == null || queue.Pending > 16)
        {
            sb.Dispose();
            return;
        }
        queue.Post(() =>
        {
            try
            {
                EncodeAudio(sb);
            }
            finally
            {
                sb.Dispose();
            }
        });
    }

    double RelativeUs(CMTime t)
    {
        epoch ??= t;
        return Math.Max(0, (t - epoch.Value).Seconds * 1e6);
    }

    void EncodeVideo(CMSampleBuffer sb)
    {
        if (stopped) return;
        using var image = sb.GetImageBuffer();
        if (image is not CVPixelBuffer pb) return;
        var pts = sb.PresentationTimeStamp;
        var us = RelativeUs(pts);
        var minGap = 1e6 / settings.Fps * 0.85;
        if (lastEncodedUs >= 0 && us - lastEncodedUs < minGap) return;

        var rot = RotationOf(sb);
        if (rot != rotation)
        {
            rotation = rot;
            if (avcC != null)
            {
                PublishConfig();
                forceKey = true;
            }
        }

        var w = (int)pb.Width;
        var h = (int)pb.Height;
        var (ow, oh) = H264Encoder.OutputSize(w, h, settings.Quality.LongSide());
        if (encoder == null || encoder.Width != ow || encoder.Height != oh)
        {
            encoder?.Dispose();
            try
            {
                var e = new H264Encoder(ow, oh, settings.Fps, settings.Quality.Bitrate());
                e.OnParameterSets = (sps, pps) => queue.Post(() => ParameterSetsChanged(sps, pps, ow, oh));
                e.OnEncoded = (data, key, time) => queue.Post(() => Encoded(data, key, time));
                e.OnError = m => queue.Post(() => Log(m));
                encoder = e;
            }
            catch (Exception ex)
            {
                Fatal("The video encoder could not be started: " + ex.Message);
                return;
            }
            forceKey = true;
        }
        var key = forceKey;
        forceKey = false;
        lastEncodedUs = us;
        encoder.Encode(pb, pts, key);
    }

    void ParameterSetsChanged(byte[] sps, byte[] pps, int width, int height)
    {
        videoCodec = MirrorProtocol.AvcCodecString(sps);
        avcC = MirrorProtocol.AvcC(sps, pps);
        videoWidth = width;
        videoHeight = height;
        status.Width = width;
        status.Height = height;
        PublishConfig();
    }

    void PublishConfig()
    {
        if (avcC == null) return;
        var json = MirrorProtocol.ConfigJson(settings.DeviceName, videoCodec, videoWidth, videoHeight, avcC, rotation, settings.Fps, aac?.SampleRate, aac?.Channels ?? 0, aac?.AudioSpecificConfig);
        var data = MirrorProtocol.ConfigMessage(json);
        configData = data;
        relay?.SendConfig(data);
        local?.Broadcast(data);
    }

    void Encoded(byte[] data, bool key, CMTime time)
    {
        if (configData == null) return;
        var us = RelativeUs(time);
        status.VideoFrames++;
        status.Rotation = rotation;
        Emit(MirrorProtocol.FrameMessage(true, key, us, data), true, key);
    }

    void EncodeAudio(CMSampleBuffer sb)
    {
        if (stopped || aac == null) return;
        aac.Append(sb, RelativeUs(sb.PresentationTimeStamp));
    }

    /// <summary>The viewer that plays through MSE waits for both tracks: when the app is quiet, silence keeps the sound track going.</summary>
    void TickSilence()
    {
        if (stopped || aac == null || epoch == null || configData == null) return;
        var nowUs = Math.Max(0, (CMClock.HostTimeClock.CurrentTime - epoch.Value).Seconds * 1e6);
        if (nowUs - aac.LastRealAudioAt > 150_000) aac.AppendSilence(nowUs - 100_000);
    }

    // ---- frames out

    void Emit(byte[] message, bool isVideo, bool key)
    {
        bytesThisSecond += message.Length;
        if (relayDemand) relay?.SendFrame(message, isVideo, key);
        local?.BroadcastFrame(message, isVideo, key);
    }

    void TickStatus()
    {
        if (stopped) return;
        status.Kbps = (int)(bytesThisSecond * 8 / 1000);
        bytesThisSecond = 0;
        status.UpdatedAt = DateTime.UtcNow;
        status.LocalAddresses = LocalAddresses.IPv4();
        status.Write();
        MirrorSignals.Post(MirrorSignals.Alive);
    }

    /// <summary>ReplayKit marks each frame with the screen's orientation (CGImagePropertyOrientation); the viewer turns the picture clockwise by this.</summary>
    static int RotationOf(CMSampleBuffer sb)
    {
        try
        {
            var n = sb.GetAttachment<NSNumber>("RPVideoSampleOrientationKey", out _);
            if (n == null) return 0;
            return n.Int32Value switch
            {
                1 or 2 => 0,   // up
                6 or 7 => 90,  // right
                3 or 4 => 180, // down
                8 or 5 => 270, // left
                _ => 0,
            };
        }
        catch
        {
            return 0;
        }
    }
}
