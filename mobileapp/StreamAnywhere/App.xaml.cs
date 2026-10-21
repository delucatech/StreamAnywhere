namespace StreamAnywhere
{
    public partial class App : Application
    {
        public App()
        {
            InitializeComponent();
            // one look everywhere: the dark theme (the colours in Resources/Styles/Colors.xaml)
            UserAppTheme = AppTheme.Dark;
        }

        protected override Window CreateWindow(IActivationState? activationState)
        {
            return new Window(new AppShell());
        }
    }
}
