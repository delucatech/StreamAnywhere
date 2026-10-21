using Microsoft.Extensions.Logging;
using Microsoft.Maui.LifecycleEvents;
using StreamAnywhere.Mirror;

namespace StreamAnywhere
{
    public static class MauiProgram
    {
        public static MauiApp CreateMauiApp()
        {
            var builder = MauiApp.CreateBuilder();
            builder
                .UseMauiApp<App>()
                .ConfigureFonts(fonts =>
                {
                    fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
                    fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
                })
                .ConfigureMauiHandlers(handlers =>
                {
#if IOS
                    handlers.AddHandler<BroadcastPickerView, BroadcastPickerHandler>();
#endif
                })
                .ConfigureLifecycleEvents(events =>
                {
#if IOS
                    // streamanywhere://pair?… from the pairing landing page (a code scanned with the Camera app)
                    // (a plain launch carries no URL at all: every one of these may be null)
                    events.AddiOS(ios => ios
                        .OpenUrl((_, url, _) =>
                        {
                            PairLink.Receive(url?.AbsoluteString);
                            return true;
                        })
                        .SceneOpenUrl((_, contexts) =>
                        {
                            if (contexts != null)
                                foreach (var c in contexts) PairLink.Receive(c?.Url?.AbsoluteString);
                            return true;
                        })
                        .SceneWillConnect((_, _, options) =>
                        {
                            var contexts = options?.UrlContexts;
                            if (contexts != null)
                                foreach (var c in contexts) PairLink.Receive(c?.Url?.AbsoluteString);
                        }));
#endif
                });

            // Mirror (the screen to the Tesla): the real thing on iOS, a stub that says so elsewhere
#if IOS
            builder.Services.AddSingleton<IMirrorPlatform, MirrorPlatform>();
#else
            builder.Services.AddSingleton<IMirrorPlatform, MirrorPlatformStub>();
#endif
            builder.Services.AddTransient<MirrorPage>();

#if DEBUG
            builder.Logging.AddDebug();
#endif

            return builder.Build();
        }
    }
}
