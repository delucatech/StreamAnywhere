// iOS: a full-screen camera view that reads one QR code (the pairing code on the Tesla's screen) and
// dismisses itself. AVFoundation only: the camera, a metadata output set to QR codes, a preview layer,
// a viewfinder frame and a Cancel button. Needs NSCameraUsageDescription (Info.plist).
using AVFoundation;
using CoreFoundation;
using CoreGraphics;
using Foundation;
using UIKit;

namespace StreamAnywhere.Mirror;

public sealed class QrScannerController : UIViewController
{
    readonly TaskCompletionSource<string?> result = new(TaskCreationOptions.RunContinuationsAsynchronously);
    AVCaptureSession? session;
    AVCaptureVideoPreviewLayer? preview;
    UILabel? hint;
    bool done;

    /// <summary>The text of the first code seen; null when the user cancelled or the camera is unavailable</summary>
    public Task<string?> Result => result.Task;

    public QrScannerController()
    {
        ModalPresentationStyle = UIModalPresentationStyle.FullScreen;
    }

    public override void ViewDidLoad()
    {
        base.ViewDidLoad();
        var view = View!;
        view.BackgroundColor = UIColor.Black;

        var title = new UILabel
        {
            Text = "Pair with the Tesla",
            TextColor = UIColor.White,
            Font = UIFont.BoldSystemFontOfSize(22),
            TextAlignment = UITextAlignment.Center,
            TranslatesAutoresizingMaskIntoConstraints = false,
        };
        hint = new UILabel
        {
            Text = "Point the camera at the code on the Tesla's screen",
            TextColor = UIColor.FromWhiteAlpha(1, 0.8f),
            Font = UIFont.SystemFontOfSize(16),
            TextAlignment = UITextAlignment.Center,
            Lines = 0,
            TranslatesAutoresizingMaskIntoConstraints = false,
        };
        var frame = new UIView
        {
            TranslatesAutoresizingMaskIntoConstraints = false,
            BackgroundColor = UIColor.Clear,
        };
        frame.Layer.BorderColor = UIColor.FromRGB(0x4f, 0x8c, 0xff).CGColor;
        frame.Layer.BorderWidth = 3;
        frame.Layer.CornerRadius = 24;
        var cancel = new UIButton(UIButtonType.System) { TranslatesAutoresizingMaskIntoConstraints = false };
        cancel.SetTitle("Cancel", UIControlState.Normal);
        cancel.SetTitleColor(UIColor.White, UIControlState.Normal);
        cancel.TitleLabel.Font = UIFont.SystemFontOfSize(18, UIFontWeight.Semibold);
        cancel.BackgroundColor = UIColor.FromWhiteAlpha(1, 0.14f);
        cancel.Layer.CornerRadius = 16;
        cancel.TouchUpInside += (_, _) => Finish(null);

        view.AddSubviews(frame, title, hint, cancel);
        var safe = view.SafeAreaLayoutGuide;
        NSLayoutConstraint.ActivateConstraints(new[]
        {
            title.TopAnchor.ConstraintEqualTo(safe.TopAnchor, 24),
            title.LeadingAnchor.ConstraintEqualTo(safe.LeadingAnchor, 20),
            title.TrailingAnchor.ConstraintEqualTo(safe.TrailingAnchor, -20),
            hint.TopAnchor.ConstraintEqualTo(title.BottomAnchor, 8),
            hint.LeadingAnchor.ConstraintEqualTo(safe.LeadingAnchor, 20),
            hint.TrailingAnchor.ConstraintEqualTo(safe.TrailingAnchor, -20),
            frame.CenterXAnchor.ConstraintEqualTo(view.CenterXAnchor),
            frame.CenterYAnchor.ConstraintEqualTo(view.CenterYAnchor, -20),
            frame.WidthAnchor.ConstraintEqualTo(view.WidthAnchor, 0.7f),
            frame.HeightAnchor.ConstraintEqualTo(frame.WidthAnchor),
            cancel.BottomAnchor.ConstraintEqualTo(safe.BottomAnchor, -24),
            cancel.CenterXAnchor.ConstraintEqualTo(view.CenterXAnchor),
            cancel.WidthAnchor.ConstraintEqualTo(160),
            cancel.HeightAnchor.ConstraintEqualTo(52),
        });
    }

    public override void ViewDidAppear(bool animated)
    {
        base.ViewDidAppear(animated);
        _ = StartAsync();
    }

    public override void ViewDidLayoutSubviews()
    {
        base.ViewDidLayoutSubviews();
        if (preview != null) preview.Frame = View!.Bounds;
    }

    async Task StartAsync()
    {
        var status = AVCaptureDevice.GetAuthorizationStatus(AVAuthorizationMediaType.Video);
        if (status == AVAuthorizationStatus.NotDetermined)
        {
            if (!await AVCaptureDevice.RequestAccessForMediaTypeAsync(AVAuthorizationMediaType.Video))
            {
                ShowProblem("The camera was not allowed. Allow it for StreamAnywhere in Settings, or type the server address and password under Settings in the app.");
                return;
            }
        }
        else if (status != AVAuthorizationStatus.Authorized)
        {
            ShowProblem("The camera is not allowed for StreamAnywhere. Allow it in Settings → StreamAnywhere → Camera.");
            return;
        }
        var device = AVCaptureDevice.GetDefaultDevice(AVMediaTypes.Video);
        if (device == null)
        {
            ShowProblem("No camera on this device.");
            return;
        }
        var input = AVCaptureDeviceInput.FromDevice(device, out var error);
        if (input == null || error != null)
        {
            ShowProblem("The camera could not be opened: " + (error?.LocalizedDescription ?? "unknown error"));
            return;
        }
        var s = new AVCaptureSession();
        if (!s.CanAddInput(input))
        {
            ShowProblem("The camera could not be opened.");
            return;
        }
        s.AddInput(input);
        var output = new AVCaptureMetadataOutput();
        if (!s.CanAddOutput(output))
        {
            ShowProblem("This camera cannot read codes.");
            return;
        }
        s.AddOutput(output);
        output.SetDelegate(new CodeDelegate(this), DispatchQueue.MainQueue);
        output.MetadataObjectTypes = AVMetadataObjectType.QRCode;
        session = s;
        preview = new AVCaptureVideoPreviewLayer(s) { Frame = View!.Bounds, VideoGravity = AVLayerVideoGravity.ResizeAspectFill };
        View.Layer.InsertSublayer(preview, 0);
        await Task.Run(() => s.StartRunning());
    }

    void ShowProblem(string message)
    {
        if (hint != null)
        {
            hint.Text = message;
            hint.TextColor = UIColor.FromRGB(0xff, 0x6b, 0x7a);
        }
    }

    void Finish(string? text)
    {
        if (done) return;
        done = true;
        var s = session;
        session = null;
        if (s != null) Task.Run(() => s.StopRunning());
        DismissViewController(true, () => result.TrySetResult(text));
    }

    sealed class CodeDelegate : AVCaptureMetadataOutputObjectsDelegate
    {
        readonly QrScannerController owner;
        public CodeDelegate(QrScannerController owner) => this.owner = owner;

        public override void DidOutputMetadataObjects(AVCaptureMetadataOutput captureOutput, AVMetadataObject[] metadataObjects, AVCaptureConnection connection)
        {
            foreach (var m in metadataObjects)
            {
                if (m is AVMetadataMachineReadableCodeObject code && code.StringValue is { Length: > 0 } text)
                {
                    owner.Finish(text);
                    return;
                }
            }
        }
    }
}
