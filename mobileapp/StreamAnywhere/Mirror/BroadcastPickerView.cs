// The system's own "start broadcast" button (RPSystemBroadcastPickerView on iOS): tapping it opens
// the sheet where the user picks StreamAnywhere and starts the broadcast. Rendered by
// Platforms/iOS/BroadcastPickerHandler.cs; on other platforms it is an empty view.
namespace StreamAnywhere.Mirror;

public class BroadcastPickerView : View
{
    public static readonly BindableProperty TitleProperty = BindableProperty.Create(nameof(Title), typeof(string), typeof(BroadcastPickerView), "Start mirroring");
    public static readonly BindableProperty ExtensionBundleIdProperty = BindableProperty.Create(nameof(ExtensionBundleId), typeof(string), typeof(BroadcastPickerView), "");

    public string Title
    {
        get => (string)GetValue(TitleProperty);
        set => SetValue(TitleProperty, value);
    }

    public string ExtensionBundleId
    {
        get => (string)GetValue(ExtensionBundleIdProperty);
        set => SetValue(ExtensionBundleIdProperty, value);
    }
}
