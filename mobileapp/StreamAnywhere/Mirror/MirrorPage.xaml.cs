// The Mirror page: the room code the Tesla types, the start button, what is going on, the settings.
// The mirroring itself happens in the broadcast extension (StreamAnywhere.Broadcast), which keeps
// running when this app is in the background; this page reads its status once a second.
namespace StreamAnywhere.Mirror;

public partial class MirrorPage : ContentPage
{
    readonly IMirrorPlatform platform;
    MirrorSettingsView settings;
    bool loading = true;
    IDispatcherTimer? timer;

    public MirrorPage(IMirrorPlatform platform)
    {
        InitializeComponent();
        this.platform = platform;
        settings = platform.Load();
        Picker.ExtensionBundleId = platform.ExtensionBundleId;
        Picker.IsVisible = platform.Supported;
        Unsupported.IsVisible = !platform.Supported;
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
        if (!RoomCode.IsValid(settings.Room)) _ = NewRoomAsync();
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        timer?.Stop();
    }

    void ShowSettings()
    {
        RoomLabel.Text = string.IsNullOrEmpty(settings.Room) ? "······" : settings.Room;
        UseServer.IsToggled = settings.UseServer;
        ServerEntry.Text = settings.ServerUrl;
        NameEntry.Text = settings.DeviceName;
        QualityPicker.SelectedIndex = settings.Quality switch { "Saver" => 0, "Sharp" => 2, _ => 1 };
        FpsPicker.SelectedIndex = settings.Fps switch { 15 => 0, 24 => 1, 60 => 3, _ => 2 };
        AudioSwitch.IsToggled = settings.Audio;
        MicSwitch.IsToggled = settings.Microphone;
        SignInButton.Text = settings.SignedIn ? "Signed in – sign in again" : "Sign in";
        ServerEntry.IsEnabled = PasswordEntry.IsEnabled = SignInButton.IsEnabled = settings.UseServer;
        LinkLabel.Text = "";
        if (settings.UseServer && RoomCode.IsValid(settings.Room) && Uri.TryCreate(settings.ServerUrl.Trim(), UriKind.Absolute, out var u))
            LinkLabel.Text = $"Or open: {new Uri(u, "/mirror.html?room=" + settings.Room)}";
        var addresses = platform.LocalAddresses();
        LocalLabel.IsVisible = addresses.Count > 0 && platform.Supported;
        LocalLabel.Text = addresses.Count == 0 ? "" : "Tesla on this phone's hotspot (or the same Wi-Fi)? Open instead:\n" + string.Join("\n", addresses.Select(a => $"http://{a}:{platform.LocalPagePort}/")) + "\nNo internet needed; the picture never leaves the hotspot.";
    }

    MirrorSettingsView ReadSettings() => settings with
    {
        UseServer = UseServer.IsToggled,
        ServerUrl = (ServerEntry.Text ?? "").Trim(),
        DeviceName = string.IsNullOrWhiteSpace(NameEntry.Text) ? settings.DeviceName : NameEntry.Text.Trim(),
        Quality = QualityPicker.SelectedIndex switch { 0 => "Saver", 2 => "Sharp", _ => "Balanced" },
        Fps = FpsPicker.SelectedIndex switch { 0 => 15, 1 => 24, 3 => 60, _ => 30 },
        Audio = AudioSwitch.IsToggled,
        Microphone = MicSwitch.IsToggled,
    };

    void OnSettingChanged(object? sender, EventArgs e)
    {
        if (loading) return;
        settings = ReadSettings();
        platform.Save(settings);
        loading = true;
        ShowSettings();
        loading = false;
    }

    async void OnNewCode(object? sender, EventArgs e) => await NewRoomAsync();

    async Task NewRoomAsync()
    {
        if (!platform.Supported) return;
        try
        {
            var code = await platform.NewRoomAsync();
            settings = settings with { Room = code };
            loading = true;
            ShowSettings();
            loading = false;
        }
        catch (Exception ex)
        {
            StatusLabel.Text = "Could not get a code: " + ex.Message;
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
            await NewRoomAsync();
        }
        catch (Exception ex)
        {
            SignInLabel.Text = ex.Message;
        }
        finally
        {
            loading = true;
            ShowSettings();
            loading = false;
        }
    }

    void OnTick(object? sender, EventArgs e)
    {
        var s = platform.Status();
        if (s == null || s.State == "idle" || (!s.Live && s.State == "live"))
        {
            StatusLabel.Text = "Not mirroring.";
            Picker.Title = "Start mirroring";
            StartHint.Text = platform.Supported ? "iOS asks which app receives the broadcast: choose StreamAnywhere and tap Start Broadcast. Then open the app you want on the Tesla." : "";
            return;
        }
        var lines = new List<string> { $"State: {s.State}" };
        if (s.Width > 0) lines.Add($"Picture: {s.Width}×{s.Height}{(s.Rotation != 0 ? $", turned {s.Rotation}°" : "")}");
        lines.Add($"Sending: {(s.Kbps >= 1000 ? $"{s.Kbps / 1000.0:0.0} Mb/s" : $"{s.Kbps} kb/s")}");
        lines.Add($"Server relay: {s.Relay}");
        lines.Add($"Watching: {s.Watchers} via server · {s.LocalClients} on the hotspot");
        if (s.Message.Length > 0) lines.Add(s.Message);
        StatusLabel.Text = string.Join("\n", lines);
        Picker.Title = s.Live ? "Mirroring – tap to stop" : "Start mirroring";
        StartHint.Text = s.Live ? "The red indicator at the top of the screen means the screen is being mirrored. Tap it (or this button) to stop." : "";
    }
}
