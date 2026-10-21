// The "local direct" way: the phone serves the viewer page itself (plain HTTP on 8420, one bundled
// file) and streams the frames over a WebSocket on 8421, for a Tesla on the phone's hotspot
// (http://172.20.10.1:8420/) or any device on the same Wi-Fi. Network.framework does the WebSocket
// handshake and framing; the HTTP side is one static answer.
using System.Text;
using CoreFoundation;
using Foundation;
using Network;
using StreamAnywhere.Mirror;

namespace StreamAnywhere.Broadcast;

public sealed class LocalServer
{
    NWListener? pageListener;
    NWListener? socketListener;
    readonly SerialQueue queue;
    readonly DispatchQueue dispatch = new DispatchQueue("mirror.local");
    readonly Dictionary<NWConnection, Client> clients = new();
    readonly byte[] page;
    public bool Running { get; private set; }
    public string Name { get; set; } = "iPhone";

    public Action? OnClientJoined;
    public Action<int>? OnClientsChanged;
    public Action? OnNeedKey;
    public Action<string>? OnLog;
    public int ClientCount => clients.Count;

    sealed class Client
    {
        public int PendingBytes;
        public bool Skipping = true;
    }

    const int HighWater = 3 * 1024 * 1024;
    const int LowWater = 256 * 1024;

    public LocalServer(SerialQueue queue)
    {
        this.queue = queue;
        var path = NSBundle.MainBundle.PathForResource("viewer", "html");
        page = path != null && File.Exists(path)
            ? File.ReadAllBytes(path)
            : Encoding.UTF8.GetBytes("<!doctype html><title>Mirror</title><p>viewer.html is missing from the app bundle (run npm run build:mirror-local -w client).");
    }

    public void Start()
    {
        if (Running) return;
        Running = true;
        StartPage();
        StartSocket();
    }

    void StartPage()
    {
        try
        {
            var p = NWParameters.CreateTcp(_ => { });
            p.ReuseLocalAddress = true;
            var l = NWListener.Create(MirrorProtocol.LocalPagePort.ToString(), p);
            l.SetNewConnectionHandler(ServePage);
            l.SetStateChangedHandler((st, err) =>
            {
                if (st == NWListenerState.Failed) OnLog?.Invoke($"page listener failed: {err?.ErrorCode}");
            });
            l.SetQueue(dispatch);
            l.Start();
            pageListener = l;
        }
        catch (Exception e)
        {
            OnLog?.Invoke("page listener: " + e.Message);
        }
    }

    /// <summary>Any GET gets the viewer page (a browser also asks for /favicon.ico: a 404 is harmless).</summary>
    void ServePage(NWConnection c)
    {
        c.SetQueue(dispatch);
        c.Start();
        c.ReceiveData(1, 64 * 1024, (data, context, isComplete, error) =>
        {
            var request = data == null ? "" : Encoding.UTF8.GetString(data.ToArray());
            var notFound = request.StartsWith("GET /favicon");
            var head = notFound
                ? "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                : $"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {page.Length}\r\nConnection: close\r\n\r\n";
            var headBytes = Encoding.ASCII.GetBytes(head);
            byte[] body;
            if (notFound || request.StartsWith("HEAD ")) body = headBytes;
            else
            {
                body = new byte[headBytes.Length + page.Length];
                Buffer.BlockCopy(headBytes, 0, body, 0, headBytes.Length);
                Buffer.BlockCopy(page, 0, body, headBytes.Length, page.Length);
            }
            c.Send(body, NWContentContext.FinalMessage, true, _ => c.Cancel());
        });
    }

    void StartSocket()
    {
        try
        {
            var p = NWParameters.CreateTcp(_ => { });
            p.ReuseLocalAddress = true;
            var ws = new NWWebSocketOptions(NWWebSocketVersion.Version13);
            ws.AutoReplyPing = true;
            ws.MaximumMessageSize = (nuint)(1024 * 1024);
            p.ProtocolStack.PrependApplicationProtocol(ws);
            var l = NWListener.Create(MirrorProtocol.LocalSocketPort.ToString(), p);
            l.SetNewConnectionHandler(Accept);
            l.SetStateChangedHandler((st, err) =>
            {
                if (st == NWListenerState.Failed) OnLog?.Invoke($"socket listener failed: {err?.ErrorCode}");
            });
            l.SetQueue(dispatch);
            l.Start();
            socketListener = l;
        }
        catch (Exception e)
        {
            OnLog?.Invoke("socket listener: " + e.Message);
        }
    }

    void Accept(NWConnection c)
    {
        c.SetStateChangeHandler((st, err) =>
        {
            switch (st)
            {
                case NWConnectionState.Ready:
                    queue.Post(() =>
                    {
                        clients[c] = new Client();
                        SendText(c, MirrorControl.Hello(Name));
                        OnClientsChanged?.Invoke(clients.Count);
                        OnClientJoined?.Invoke();
                    });
                    ReadLoop(c);
                    break;
                case NWConnectionState.Failed:
                case NWConnectionState.Cancelled:
                    queue.Post(() =>
                    {
                        if (clients.Remove(c)) OnClientsChanged?.Invoke(clients.Count);
                    });
                    break;
            }
        });
        c.SetQueue(dispatch);
        c.Start();
    }

    void ReadLoop(NWConnection c)
    {
        c.ReceiveMessageData((data, context, isComplete, error) =>
        {
            if (error != null)
            {
                c.Cancel();
                return;
            }
            var meta = context?.GetProtocolMetadata(NWProtocolDefinition.CreateWebSocketDefinition()) as NWWebSocketMetadata;
            if (meta != null)
            {
                if (meta.OpCode == NWWebSocketOpCode.Close)
                {
                    c.Cancel();
                    return;
                }
                if (meta.OpCode == NWWebSocketOpCode.Text && data != null)
                {
                    var text = Encoding.UTF8.GetString(data.ToArray());
                    var t = MirrorControl.TypeOf(text, out _);
                    if (t == "ping") SendText(c, MirrorControl.Pong);
                    if (t == "need-key") queue.Post(() =>
                    {
                        if (clients.TryGetValue(c, out var cl)) cl.Skipping = true;
                        OnNeedKey?.Invoke();
                    });
                }
            }
            ReadLoop(c);
        });
    }

    static NWContentContext MessageContext(NWWebSocketOpCode opcode, string id)
    {
        var ctx = new NWContentContext(id);
        ctx.SetMetadata(new NWWebSocketMetadata(opcode));
        return ctx;
    }

    void SendText(NWConnection c, string text)
    {
        c.Send(Encoding.UTF8.GetBytes(text), MessageContext(NWWebSocketOpCode.Text, "text"), true, _ => { });
    }

    void SendBinary(NWConnection c, Client client, byte[] data)
    {
        client.PendingBytes += data.Length;
        c.Send(data, MessageContext(NWWebSocketOpCode.Binary, "bin"), true, _ => queue.Post(() => client.PendingBytes -= data.Length));
    }

    public void Broadcast(byte[] config)
    {
        foreach (var (c, cl) in clients) SendBinary(c, cl, config);
    }

    public void BroadcastFrame(byte[] frame, bool isVideo, bool key)
    {
        var wantKey = false;
        foreach (var (c, cl) in clients)
        {
            if (cl.Skipping)
            {
                if (isVideo && key && cl.PendingBytes < LowWater) cl.Skipping = false;
                else
                {
                    wantKey = true;
                    continue;
                }
            }
            else if (cl.PendingBytes > HighWater)
            {
                cl.Skipping = true;
                wantKey = true;
                continue;
            }
            SendBinary(c, cl, frame);
        }
        if (wantKey) OnNeedKey?.Invoke();
    }

    public void Stop()
    {
        Running = false;
        foreach (var c in clients.Keys.ToList()) c.Cancel();
        clients.Clear();
        pageListener?.Cancel();
        socketListener?.Cancel();
        pageListener = null;
        socketListener = null;
    }
}
