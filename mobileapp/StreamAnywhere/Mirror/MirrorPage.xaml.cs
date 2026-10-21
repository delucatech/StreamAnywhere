// The Mirror page: what is going on, the start button, "Pair with the Tesla" (scan the code on the
// car's screen), and the settings folded away. The mirroring itself happens in the broadcast
// extension (StreamAnywhere.Broadcast), which keeps running when this app is in the background;
// this page reads its status once a second.
namespace StreamAnywhere.Mirror;

public partial class MirrorPage : ContentPage
{
    static readonly Color AccentColor = Color.FromArgb("#4f8cff");
    static readonly Color OkColor = Color.FromArgb("#2ee6a6");
    static readonly Color WarnColor = Color.FromArgb("#ffb547");
    static readonly Color DangerColor = Color.FromArgb("#ff6b7a");
    static readonly Color IdleColor = Color.FromArgb("#6b7488");
    static readonly Color MutedColor = Color.FromArgb("#9aa3b5");
    static readonly Color FgColor = Color.FromArgb("#f2f4f8");
    static readonly Color RaisedColor = Color.FromArgb("#1b2030");

    readonly IMirrorPlatform platform;
    MirrorSettingsView settings;
    bool loading = true;
    bool pairing;
    IDispatcherTimer? timer;

    public MirrorPage(IMirrorPlatform platform)
    {
        InitializeComponent();
        this.platform = platform;
        settings = platform.Load();
        Picker.ExtensionBundleId = platform.ExtensionBundleId;
        Picker.IsVisible = platform.Supported;
        Unsupported.IsVisible = !platform.Supported;
        PairButton.IsEnabled = platform.Supported;
        ShowSettings();
        loading = false;
    }

    protected override void OnAppearing()
    {
        base.OnAppearing();
        timer ??= Dispatcher.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(1);
        timer.Tick -= OnTick;
        timer.Tick += OnTick;
        timer.Start();
        OnTick(null, EventArgs.Empty);
        PairLink.Received -= OnPairLink;
        PairLink.Received += OnPairLink;
        // a link that opened the app before this page was up (the landing page's button)
        if (PairLink.TakePending() is { } link) OnPairLink(link);
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        timer?.Stop();
        PairLink.Received -= OnPairLink;
    }

    // ------------------------------------------------------------ the settings on screen

    void ShowSettings()
    {
        loading = true;
        UseServer.IsToggled = settings.UseServer;
        ServerEntry.Text = settings.ServerUrl;
        NameEntry.Text = settings.DeviceName;
        AudioSwitch.IsToggled = settings.Audio;
        MicSwitch.IsToggled = settings.Microphone;
        Segment(QualitySaver, settings.Quality == "Saver");
        Segment(QualityBalanced, settings.Quality is not ("Saver" or "Sharp"));
        Segment(QualitySharp, settings.Quality == "Sharp");
        Segment(Fps15, settings.Fps == 15);
        Segment(Fps24, settings.Fps == 24);
        Segment(Fps30, settings.Fps is not (15 or 24 or 60));
        Segment(Fps60, settings.Fps == 60);
        QualityHint.Text = settings.Quality switch
        {
            "Saver" => "480p, 1.5 Mb/s: for the car's own LTE through the server.",
            "Sharp" => "1080p, 6 Mb/s: for the hotspot or a shared Wi-Fi.",
            _ => "720p, 3 Mb/s: a good default either way.",
        };
        SignInButton.Text = settings.SignedIn ? "Signed in – sign in again" : "Sign in";
        ServerEntry.IsEnabled = PasswordEntry.IsEnabled = SignInButton.IsEnabled = settings.UseServer;
        PairButton.Text = settings.Paired ? "Pair with the Tesla again" : "Pair with the Tesla";
        PairedLabel.Text = !settings.UseServer ? "Server off: hotspot only."
            : settings.Paired ? $"Paired with {settings.ServerHost} · code {settings.Room}"
            : settings.SignedIn ? $"Signed in to {settings.ServerHost}; no room from the car yet."
            : "Not paired: scan the code on the Tesla, or sign in below.";
        RoomLabel.Text = RoomCode.IsValid(settings.Room) ? $"Code  {settings.Room}" : "No code yet";
        var addresses = platform.LocalAddresses();
        LocalCard.IsVisible = addresses.Count > 0 && platform.Supported;
        LocalLabel.Text = addresses.Count == 0 ? "" : "Open " + string.Join(" or ", addresses.Select(a => $"http://{a}:{platform.LocalPagePort}/")) + " in the car's browser: no internet needed, the picture never leaves the hotspot.";
        loading = false;
    }

    static void Segment(Button b, bool on)
    {
        b.BackgroundColor = on ? RaisedColor : Colors.Transparent;
        b.TextColor = on ? FgColor : MutedColor;
    }

    MirrorSettingsView ReadSettings() => settings with
    {
        UseServer = UseServer.IsToggled,
        ServerUrl = (ServerEntry.Text ?? "").Trim(),
        DeviceName = string.IsNullOrWhiteSpace(NameEntry.Text) ? settings.DeviceName : NameEntry.Text.Trim(),
        Audio = AudioSwitch.IsToggled,
        Microphone = MicSwitch.IsToggled,
    };

    void Apply(MirrorSettingsView s)
    {
        settings = s;
        platform.Save(settings);
        ShowSettings();
        OnTick(null, EventArgs.Empty);
    }

    void OnSettingChanged(object? sender, EventArgs e)
    {
        if (loading) return;
        Apply(ReadSettings());
    }

    void OnQuality(object? sender, EventArgs e)
    {
        if (loading) return;
        Apply(ReadSettings() with { Quality = sender == QualitySaver ? "Saver" : sender == QualitySharp ? "Sharp" : "Balanced" });
    }

    void OnFps(object? sender, EventArgs e)
    {
        if (loading) return;
        Apply(ReadSettings() with { Fps = sender == Fps15 ? 15 : sender == Fps24 ? 24 : sender == Fps60 ? 60 : 30 });
    }

    void OnToggleSettings(object? sender, EventArgs e)
    {
        SettingsPanel.IsVisible = !SettingsPanel.IsVisible;
        SettingsToggle.Text = SettingsPanel.IsVisible ? "Done" : "Settings";
    }

    void OnTogglePassword(object? sender, EventArgs e) => PasswordPanel.IsVisible = !PasswordPanel.IsVisible;

    // ------------------------------------------------------------ pairing

    async void OnPair(object? sender, EventArgs e)
    {
        if (pairing || !platform.Supported) return;
        string? text;
        try
        {
            text = await platform.ScanPairingCodeAsync();
        }
        catch (Exception ex)
        {
            ShowPairResult("The camera could not be opened: " + ex.Message, DangerColor);
            return;
        }
        if (text == null) return;
        if (!PairLink.TryParse(text, out var server, out var token))
        {
            ShowPairResult("That is not a StreamAnywhere pairing code. Scan the code on the Tesla's Mirror page.", DangerColor);
            return;
        }
        await PairAsync(server, token);
    }

    void OnPairLink(string link)
    {
        if (!PairLink.TryParse(link, out var server, out var token)) return;
        MainThread.BeginInvokeOnMainThread(() => _ = PairAsync(server, token));
    }

    async Task PairAsync(string server, string token)
    {
        if (pairing) return;
        pairing = true;
        PairButton.IsEnabled = false;
        ShowPairResult("Pairing…", MutedColor);
        try
        {
            settings = await platform.PairAsync(server, token);
            ShowSettings();
            ShowPairResult($"Paired with the Tesla through {settings.ServerHost}. Tap Start mirroring.", OkColor);
        }
        catch (Exception ex)
        {
            ShowPairResult(ex.Message, DangerColor);
        }
        finally
        {
            pairing = false;
            PairButton.IsEnabled = platform.Supported;
            OnTick(null, EventArgs.Empty);
        }
    }

    void ShowPairResult(string text, Color color)
    {
        PairResult.Text = text;
        PairResult.TextColor = color;
        PairResult.IsVisible = text.Length > 0;
    }

    // ------------------------------------------------------------ the password fallback

    async void OnNewCode(object? sender, EventArgs e)
    {
        if (!platform.Supported) return;
        try
        {
            var code = await platform.NewRoomAsync();
            settings = settings with { Room = code };
            ShowSettings();
        }
        catch (Exception ex)
        {
            SignInLabel.Text = "Could not get a code: " + ex.Message;
        }
    }

    async void OnSignIn(object? sender, EventArgs e)
    {
        SignInButton.IsEnabled = false;
        SignInLabel.Text = "Signing in…";
        try
        {
            settings = ReadSettings();
            platform.Save(settings);
            await platform.SignInAsync(settings.ServerUrl, PasswordEntry.Text ?? "");
            PasswordEntry.Text = "";
            settings = platform.Load();
            SignInLabel.Text = "Signed in.";
            if (!RoomCode.IsValid(settings.Room)) await platform.NewRoomAsync();
            settings = platform.Load();
        }
        catch (Exception ex)
        {
            SignInLabel.Text = ex.Message;
        }
        finally
        {
            ShowSettings();
            OnTick(null, EventArgs.Empty);
        }
    }

    // ------------------------------------------------------------ what the extension is doing

    void OnTick(object? sender, EventArgs e)
    {
        var s = platform.Status();
        var live = s != null && s.Live;
        Picker.IsLive = live;
        Picker.Title = live ? "Stop mirroring" : "Start mirroring";
        StatsGrid.IsVisible = live;
        StateMessage.IsVisible = false;
        if (!platform.Supported)
        {
            SetState(IdleColor, "iPhone feature", "This app mirrors an iPhone's screen to the Tesla; on this device it only shows the settings.");
            StartHint.Text = "";
            return;
        }
        if (live && s != null)
        {
            SetState(OkColor, "Mirroring", s.Relay == "open" ? "The Tesla sees this screen. Open any app; the red indicator at the top means it is on." : $"Sending; server link {s.Relay}.");
            StatPicture.Text = s.Width > 0 ? $"{s.Width}×{s.Height}" : "–";
            StatRate.Text = s.Kbps >= 1000 ? $"{s.Kbps / 1000.0:0.0} Mb/s" : $"{s.Kbps} kb/s";
            StatWatching.Text = (s.Watchers + s.LocalClients).ToString();
            if (s.Message.Length > 0)
            {
                StateMessage.Text = s.Message;
                StateMessage.IsVisible = true;
            }
            StartHint.Text = "Tap the button (or the red indicator) to stop.";
            return;
        }
        if (s != null && s.State == "starting")
        {
            SetState(WarnColor, "Starting…", "Connecting to the server.");
            StartHint.Text = "";
            return;
        }
        if (s != null && s.State == "error" && s.Fresh)
        {
            SetState(DangerColor, "Stopped", s.Message.Length > 0 ? s.Message : "The broadcast ended with an error.");
        }
        else if (settings.Paired)
        {
            SetState(AccentColor, "Ready", $"Paired with {settings.ServerHost}. On the Tesla, open StreamAnywhere → Mirror; it shows the picture as soon as you start.");
        }
        else if (!settings.UseServer)
        {
            SetState(AccentColor, "Hotspot only", "The server is off: the car opens this phone's own page over the hotspot (below).");
        }
        else
        {
            SetState(IdleColor, "Not paired yet", "Pair this iPhone with the Tesla once; after that, just start.");
        }
        StartHint.Text = "iOS asks which app receives the broadcast: choose StreamAnywhere, then Start Broadcast.";
    }

    void SetState(Color dot, string title, string detail)
    {
        StateDot.Fill = new SolidColorBrush(dot);
        StateLabel.Text = title;
        StateDetail.Text = detail;
    }
}
