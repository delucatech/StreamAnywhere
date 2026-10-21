// iOS: BroadcastPickerView -> RPSystemBroadcastPickerView, pointed at the broadcast extension and
// restyled as a plain blue button with our title (the system view is a bare icon).
using Microsoft.Maui.Handlers;
using ReplayKit;
using UIKit;

namespace StreamAnywhere.Mirror;

public class BroadcastPickerHandler : ViewHandler<BroadcastPickerView, RPSystemBroadcastPickerView>
{
    public static readonly IPropertyMapper<BroadcastPickerView, BroadcastPickerHandler> Mapper = new PropertyMapper<BroadcastPickerView, BroadcastPickerHandler>(ViewMapper)
    {
        [nameof(BroadcastPickerView.Title)] = (h, v) => h.Style(),
        [nameof(BroadcastPickerView.ExtensionBundleId)] = (h, v) => h.PlatformView.PreferredExtension = v.ExtensionBundleId,
    };

    public BroadcastPickerHandler() : base(Mapper) { }

    protected override RPSystemBroadcastPickerView CreatePlatformView()
    {
        var picker = new RPSystemBroadcastPickerView(CoreGraphics.CGRect.Empty)
        {
            PreferredExtension = VirtualView?.ExtensionBundleId,
            ShowsMicrophoneButton = false,
            BackgroundColor = UIColor.SystemBlue,
        };
        picker.Layer.CornerRadius = 12;
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
        var title = VirtualView?.Title ?? "Start mirroring";
        foreach (var sub in picker.Subviews)
        {
            if (sub is not UIButton button) continue;
            button.SetImage(null, UIControlState.Normal);
            button.SetTitle(title, UIControlState.Normal);
            button.SetTitleColor(UIColor.White, UIControlState.Normal);
            button.TitleLabel.Font = UIFont.BoldSystemFontOfSize(18);
            button.Frame = picker.Bounds;
            button.AutoresizingMask = UIViewAutoresizing.FlexibleWidth | UIViewAutoresizing.FlexibleHeight;
        }
    }
}
