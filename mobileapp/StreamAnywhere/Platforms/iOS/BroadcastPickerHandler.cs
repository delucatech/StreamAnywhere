// iOS: BroadcastPickerView -> RPSystemBroadcastPickerView, pointed at the broadcast extension and
// restyled as the app's big accent button with our title (the system view is a bare icon).
using Microsoft.Maui.Handlers;
using ReplayKit;
using UIKit;

namespace StreamAnywhere.Mirror;

public class BroadcastPickerHandler : ViewHandler<BroadcastPickerView, RPSystemBroadcastPickerView>
{
    static readonly UIColor Accent = UIColor.FromRGB(0x4f, 0x8c, 0xff);
    static readonly UIColor Live = UIColor.FromRGB(0xff, 0x5c, 0x6c);

    public static readonly IPropertyMapper<BroadcastPickerView, BroadcastPickerHandler> Mapper = new PropertyMapper<BroadcastPickerView, BroadcastPickerHandler>(ViewMapper)
    {
        [nameof(BroadcastPickerView.Title)] = (h, v) => h.Style(),
        [nameof(BroadcastPickerView.IsLive)] = (h, v) => h.Style(),
        [nameof(BroadcastPickerView.ExtensionBundleId)] = (h, v) => h.PlatformView.PreferredExtension = v.ExtensionBundleId,
    };

    public BroadcastPickerHandler() : base(Mapper) { }

    protected override RPSystemBroadcastPickerView CreatePlatformView()
    {
        var picker = new RPSystemBroadcastPickerView(CoreGraphics.CGRect.Empty)
        {
            PreferredExtension = VirtualView?.ExtensionBundleId,
            ShowsMicrophoneButton = false,
            BackgroundColor = Accent,
        };
        picker.Layer.CornerRadius = 18;
        return picker;
    }

    protected override void ConnectHandler(RPSystemBroadcastPickerView platformView)
    {
        base.ConnectHandler(platformView);
        Style();
    }

    void Style()
    {
        var picker = PlatformView;
        if (picker == null) return;
        var title = VirtualView?.Title ?? "Start mirroring";
        picker.BackgroundColor = VirtualView?.IsLive == true ? Live : Accent;
        try
        {
            foreach (var sub in picker.Subviews)
            {
                if (sub is not UIButton button) continue;
                // the system button is a bare icon; give it our title (iOS 15+ buttons may carry a
                // configuration instead of a title label - then only the image and tint can be changed)
                button.SetImage(null, UIControlState.Normal);
                button.SetTitle(title, UIControlState.Normal);
                button.SetTitleColor(UIColor.White, UIControlState.Normal);
                button.TintColor = UIColor.White;
                if (button.TitleLabel != null) button.TitleLabel.Font = UIFont.SystemFontOfSize(19, UIFontWeight.Bold);
                button.Frame = picker.Bounds;
                button.AutoresizingMask = UIViewAutoresizing.FlexibleWidth | UIViewAutoresizing.FlexibleHeight;
            }
        }
        catch (Exception e)
        {
            // cosmetics only: the button must still open the broadcast sheet
            Console.WriteLine($"[Mirror] start button styling: {e.Message}");
        }
    }
}
