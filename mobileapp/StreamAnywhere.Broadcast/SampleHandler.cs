// The Broadcast Upload Extension's entry point (Info.plist: NSExtensionPrincipalClass = SampleHandler):
// iOS calls this with the screen's frames and the app's sound once the user starts the broadcast.
using CoreMedia;
using Foundation;
using ReplayKit;
using StreamAnywhere.Mirror;

namespace StreamAnywhere.Broadcast;

[Register("SampleHandler")]
public class SampleHandler : RPBroadcastSampleHandler
{
    readonly Broadcaster broadcaster = new();
    bool paused;
    bool microphone;

    public SampleHandler(IntPtr handle) : base(handle) { }
    public SampleHandler() { }

    public override void BroadcastStarted(NSDictionary<NSString, NSObject>? setupInfo)
    {
        microphone = MirrorSettings.Load().Microphone;
        broadcaster.OnFatal = message =>
        {
            var error = new NSError(new NSString("com.delucatech.streamanywhere"), 1, new NSDictionary(NSError.LocalizedDescriptionKey, new NSString(message)));
            FinishBroadcast(error);
        };
        broadcaster.Start();
    }

    public override void BroadcastPaused() => paused = true;
    public override void BroadcastResumed() => paused = false;
    public override void BroadcastFinished() => broadcaster.Stop();

    public override void ProcessSampleBuffer(CMSampleBuffer sampleBuffer, RPSampleBufferType sampleBufferType)
    {
        if (paused)
        {
            sampleBuffer.Dispose();
            return;
        }
        switch (sampleBufferType)
        {
            case RPSampleBufferType.Video:
                broadcaster.Video(sampleBuffer);
                break;
            case RPSampleBufferType.AudioApp:
                broadcaster.Audio(sampleBuffer);
                break;
            case RPSampleBufferType.AudioMic:
                if (microphone) broadcaster.Audio(sampleBuffer);
                else sampleBuffer.Dispose();
                break;
            default:
                sampleBuffer.Dispose();
                break;
        }
    }
}
