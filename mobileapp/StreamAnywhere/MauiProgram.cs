using Microsoft.Extensions.Logging;
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
