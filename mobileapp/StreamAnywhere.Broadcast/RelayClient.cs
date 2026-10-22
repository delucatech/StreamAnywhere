// The sender's WebSocket to the StreamAnywhere server (/api/mirror/ws?role=sender): frames out,
// control messages in (keyframe requests, watcher arrivals, the relay's "no frames needed").
using System.Net.WebSockets;
using System.Text;
using System.Threading.Channels;
using StreamAnywhere.Mirror;

namespace StreamAnywhere.Broadcast;

public sealed class RelayClient
{
    public enum LinkState { Off, Connecting, Open, Closed }

    readonly Uri url;
    readonly string cookie;
    readonly SerialQueue queue;
    ClientWebSocket? ws;
    CancellationTokenSource? cts;
    readonly Channel<byte[]?> outbox = Channel.CreateUnbounded<byte[]?>(new UnboundedChannelOptions { SingleReader = true });
    int reconnectDelayMs = 1000;
    bool closed;
    /// <summary>Bytes queued and not yet written: the link's backlog</summary>
    public int PendingBytes { get; private set; }
    bool skipping;
    LinkState state = LinkState.Off;
    public LinkState State
    {
        get => state;
        private set
        {
            if (state == value) return;
            state = value;
            OnState?.Invoke(value);
        }
    }
    public long BytesSent { get; private set; }

    public Action<LinkState>? OnState;
    /// <summary>A control message (the "t" and the whole element)</summary>
    public Action<string, System.Text.Json.JsonElement>? OnControl;
    public Action? OnNeedKey;
    /// <summary>Why the last connection attempt failed (shown on the phone: a 401 is "paired with another server", a 404 "no such room")</summary>
    public Action<string>? OnError;
    /// <summary>The last failure, kept for the status file</summary>
    public string LastError { get; private set; } = "";

    const int HighWater = 2 * 1024 * 1024;
    const int LowWater = 256 * 1024;

    public RelayClient(Uri server, string room, string name, string cookie, SerialQueue queue)
    {
        var b = new UriBuilder(new Uri(server, "/api/mirror/ws"));
        b.Scheme = b.Scheme == "https" ? "wss" : "ws";
        b.Query = $"room={Uri.EscapeDataString(room)}&role=sender&name={Uri.EscapeDataString(name)}";
        url = b.Uri;
        this.cookie = cookie;
        this.queue = queue;
    }

    public void Connect()
    {
        if (closed) return;
        State = LinkState.Connecting;
        _ = Task.Run(RunAsync);
    }

    async Task RunAsync()
    {
        var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        if (cookie.Length > 0) socket.Options.SetRequestHeader("Cookie", cookie);
        var c = new CancellationTokenSource();
        try
        {
            await socket.ConnectAsync(url, c.Token);
        }
        catch (Exception e)
        {
            socket.Dispose();
            Dropped(Describe(e));
            return;
        }
        queue.Post(() =>
        {
            ws = socket;
            cts = c;
            reconnectDelayMs = 1000;
            PendingBytes = 0;
            skipping = false;
            LastError = "";
            State = LinkState.Open;
        });
        // drain the outbox from the channel's queue: the frames went in on the broadcaster's queue
        var writer = Task.Run(async () =>
        {
            try
            {
                await foreach (var msg in outbox.Reader.ReadAllAsync(c.Token))
                {
                    if (msg == null) await socket.SendAsync(Array.Empty<byte>(), WebSocketMessageType.Text, true, c.Token);
                    else
                    {
                        await socket.SendAsync(msg, msg[0] == (byte)'{' ? WebSocketMessageType.Text : WebSocketMessageType.Binary, true, c.Token);
                        var n = msg.Length;
                        queue.Post(() => PendingBytes -= n);
                    }
                }
            }
            catch
            {
                /* the socket is gone; the reader notices too */
            }
        });
        var buf = new byte[64 * 1024];
        string? why = null;
        try
        {
            while (socket.State == WebSocketState.Open)
            {
                var ms = new MemoryStream();
                WebSocketReceiveResult r;
                do
                {
                    r = await socket.ReceiveAsync(buf, c.Token);
                    if (r.MessageType == WebSocketMessageType.Close) break;
                    ms.Write(buf, 0, r.Count);
                } while (!r.EndOfMessage);
                if (r.MessageType == WebSocketMessageType.Close)
                {
                    // the server closed us on purpose (4000 = another sender took the room over)
                    why = socket.CloseStatusDescription is { Length: > 0 } d ? $"the server closed the link: {d}" : null;
                    break;
                }
                if (r.MessageType == WebSocketMessageType.Text)
                {
                    var text = Encoding.UTF8.GetString(ms.ToArray());
                    var t = MirrorControl.TypeOf(text, out var root);
                    if (t != null) queue.Post(() => OnControl?.Invoke(t, root));
                }
            }
        }
        catch (Exception e)
        {
            if (!closed) why = Describe(e);
        }
        c.Cancel();
        await Task.WhenAny(writer, Task.Delay(500));
        socket.Dispose();
        Dropped(why);
    }

    /// <summary>A failed connection in the words the phone shows: the HTTP answer when the server refused the upgrade.</summary>
    static string Describe(Exception e)
    {
        var m = e is WebSocketException && e.InnerException != null ? e.InnerException.Message : e.Message;
        var status = System.Text.RegularExpressions.Regex.Match(m, @"status code '?(\d{3})");
        if (status.Success)
        {
            return status.Groups[1].Value switch
            {
                "401" => "the server does not accept this phone's sign-in (401): pair with the Tesla again",
                "404" => "the server has no such room (404): pair with the Tesla again",
                "503" => "the server is full (503)",
                var s => $"the server answered {s}",
            };
        }
        return m.Length > 140 ? m[..140] : m;
    }

    void Dropped(string? why)
    {
        queue.Post(() =>
        {
            ws = null;
            cts = null;
            if (why != null)
            {
                LastError = why;
                OnError?.Invoke(why);
            }
            State = LinkState.Closed;
            // frames queued for a dead socket are forgotten
            while (outbox.Reader.TryRead(out _)) { }
            PendingBytes = 0;
            if (closed) return;
            var delay = reconnectDelayMs;
            reconnectDelayMs = Math.Min(10_000, reconnectDelayMs * 2);
            _ = Task.Delay(delay).ContinueWith(_ => queue.Post(Connect));
        });
    }

    void Enqueue(byte[] message)
    {
        PendingBytes += message.Length;
        outbox.Writer.TryWrite(message);
    }

    public void Send(string control)
    {
        if (State != LinkState.Open) return;
        Enqueue(Encoding.UTF8.GetBytes(control));
    }

    /// <summary>The decoder configuration goes through no matter the backlog.</summary>
    public void SendConfig(byte[] config)
    {
        if (State != LinkState.Open) return;
        Enqueue(config);
    }

    /// <summary>A frame; skipped while the backlog is too big (until a keyframe, which is requested).</summary>
    public void SendFrame(byte[] frame, bool isVideo, bool key)
    {
        if (State != LinkState.Open) return;
        if (skipping)
        {
            if (isVideo && key && PendingBytes < LowWater) skipping = false;
            else return;
        }
        else if (PendingBytes > HighWater)
        {
            skipping = true;
            OnNeedKey?.Invoke();
            return;
        }
        BytesSent += frame.Length;
        Enqueue(frame);
    }

    public void Close()
    {
        closed = true;
        cts?.Cancel();
        ws = null;
        State = LinkState.Off;
    }
}

/// <summary>One thread that runs posted work in order (the extension's single timeline).</summary>
public sealed class SerialQueue
{
    readonly System.Collections.Concurrent.BlockingCollection<Action> work = new();
    readonly Thread thread;
    public int Pending => work.Count;

    public SerialQueue(string name)
    {
        thread = new Thread(() =>
        {
            foreach (var a in work.GetConsumingEnumerable())
            {
                try
                {
                    a();
                }
                catch (Exception e)
                {
                    Console.WriteLine($"[Mirror] {name}: {e}");
                }
            }
        }) { IsBackground = true, Name = name };
        thread.Start();
    }

    public void Post(Action a)
    {
        if (!work.IsAddingCompleted) work.Add(a);
    }

    /// <summary>Runs the work and waits for it (from another thread).</summary>
    public void Run(Action a)
    {
        if (Thread.CurrentThread == thread)
        {
            a();
            return;
        }
        using var done = new ManualResetEventSlim();
        Post(() =>
        {
            try
            {
                a();
            }
            finally
            {
                done.Set();
            }
        });
        done.Wait(TimeSpan.FromSeconds(5));
    }

    public void Stop() => work.CompleteAdding();
}
