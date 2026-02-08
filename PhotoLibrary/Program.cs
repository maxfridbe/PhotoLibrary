using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.CommandLine;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Drawing;
using ImageMagick;
using PhotoLibrary.Backend;
using Photino.NET;

namespace PhotoLibrary.Backend;

class Program
{
    private static ILoggerFactory _loggerFactory = LoggerFactory.Create(builder => {
        builder.AddConsole();
        builder.SetMinimumLevel(LogLevel.Information);
    });

    private static ILogger<Program> _logger = _loggerFactory.CreateLogger<Program>();

    public class AppConfig
    {
        public string? LibraryPath { get; set; }
        public string? PreviewDbPath { get; set; }
        public int Port { get; set; } = 8080;
        public string Bind { get; set; } = "localhost";
        public string Mode { get; set; } = "WebHost";
    }

    static async Task<int> Main(string[] args)
    {
        // REQ-SVC-00008: Global ImageMagick resource limits
        ResourceLimits.Memory = 1024UL * 1024 * 512; // 512MB
        ResourceLimits.Area = 1024UL * 1024 * 1024;    // 1GB
        OpenCL.IsEnabled = false;

        var rootCommand = new RootCommand("PhotoLibrary CLI - Scans and indexes photo metadata, and hosts a viewer");

        var libraryOption = new Option<string?>("--library") { Description = "Path to the SQLite database file" };
        var updateMdOption = new Option<string?>("--updatemd") { Description = "Directory to scan and update metadata for" };
        var testOneOption = new Option<bool>("--testone") { Description = "Only process one file and exit" };
        var updatePreviewsOption = new Option<bool>("--updatepreviews") { Description = "Generate previews for the scanned files" };
        var previewDbOption = new Option<string?>("--previewdb") { Description = "Path to the SQLite database for previews" };
        
        var longEdgeOption = new Option<int[]>("--longedge")
        {
            Description = "Long edge size for previews (can be specified multiple times)",
            AllowMultipleArgumentsPerToken = true
        };

        var hostOption = new Option<int?>("--host") { Description = "Port to host the web viewer on (e.g., 8080)" };
        var modeOption = new Option<string>("--mode") { Description = "Runtime mode: WebHost or PhotinoNet" };
        
        rootCommand.Add(libraryOption);
        rootCommand.Add(updateMdOption);
        rootCommand.Add(testOneOption);
        rootCommand.Add(updatePreviewsOption);
        rootCommand.Add(previewDbOption);
        rootCommand.Add(longEdgeOption);
        rootCommand.Add(hostOption);
        rootCommand.Add(modeOption);

        rootCommand.SetAction(async (parseResult, ct) =>
        {
            var libraryPath = parseResult.GetValue(libraryOption);
            var scanDir = parseResult.GetValue(updateMdOption);
            var testOne = parseResult.GetValue(testOneOption);
            var updatePreviews = parseResult.GetValue(updatePreviewsOption);
            var previewDb = parseResult.GetValue(previewDbOption);
            var longEdges = parseResult.GetValue(longEdgeOption) ?? Array.Empty<int>();
            var hostPort = parseResult.GetValue(hostOption);
            var mode = parseResult.GetValue(modeOption) ?? "WebHost";

            await Run(libraryPath, scanDir, testOne, updatePreviews, previewDb, longEdges, hostPort, mode);
        });

        return await rootCommand.Parse(args).InvokeAsync();
    }

    static async Task Run(string? libraryPath, string? scanDir, bool testOne, bool updatePreviews, string? previewDb, int[] longEdges, int? hostPort, string mode)
    {
        var version = Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "Unknown";
        _logger.LogInformation("PhotoLibrary v{Version} (Mode: {Mode}) Starting...", version, mode);

        try
        {
#if WINDOWS
            string configDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PhotoLibrary");
#else
            string configDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "PhotoLibrary");
#endif
            string configPath = Path.Combine(configDir, "config.json");
            
            if (!Directory.Exists(configDir)) Directory.CreateDirectory(configDir);

            AppConfig config;
            if (File.Exists(configPath))
            {
                try {
                    config = System.Text.Json.JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(configPath)) ?? new AppConfig();
                } catch { 
                    config = new AppConfig(); 
                }
            }
            else
            {
                config = new AppConfig {
                    LibraryPath = Path.Combine(configDir, "library.db"),
                    PreviewDbPath = Path.Combine(configDir, "previews.db"),
                    Port = 8080,
                    Bind = "localhost",
                    Mode = "WebHost"
                };
            }

            // Apply CLI overrides to config object
            if (!string.IsNullOrEmpty(libraryPath)) config.LibraryPath = PathUtils.ResolvePath(libraryPath);
            if (!string.IsNullOrEmpty(previewDb)) config.PreviewDbPath = PathUtils.ResolvePath(previewDb);
            if (hostPort.HasValue) config.Port = hostPort.Value;
            if (!string.IsNullOrEmpty(mode)) config.Mode = mode;

            // If paths are still null (shouldn't happen with defaults but safety first)
            if (string.IsNullOrEmpty(config.LibraryPath)) config.LibraryPath = Path.Combine(configDir, "library.db");
            if (string.IsNullOrEmpty(config.PreviewDbPath)) config.PreviewDbPath = Path.Combine(configDir, "previews.db");

            // Save updated config
            File.WriteAllText(configPath, System.Text.Json.JsonSerializer.Serialize(config, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));

            string finalLibraryPath = PathUtils.ResolvePath(config.LibraryPath);
            string finalPreviewDbPath = PathUtils.ResolvePath(config.PreviewDbPath);
            string bindAddr = config.Bind == "public" ? "*" : "localhost";

            IDatabaseManager dbManager = new DatabaseManager(finalLibraryPath, _loggerFactory.CreateLogger<DatabaseManager>());
            dbManager.Initialize();

            ICameraManager cameraManager = new CameraManager(configDir, _loggerFactory.CreateLogger<CameraManager>());

            IPreviewManager previewManager = new PreviewManager(finalPreviewDbPath, _loggerFactory.CreateLogger<PreviewManager>());
            previewManager.Initialize();

            // CLI/Scanning Mode
            if (!string.IsNullOrEmpty(scanDir))
            {
                scanDir = PathUtils.ResolvePath(scanDir);
                _logger.LogInformation("Library: {LibraryPath}", finalLibraryPath);
                _logger.LogInformation("Scanning: {ScanDir}", scanDir);
                
                IImageIndexer indexer = new ImageIndexer((DatabaseManager)dbManager, _loggerFactory.CreateLogger<ImageIndexer>(), (PreviewManager)previewManager, longEdges);
                indexer.Scan(scanDir, testOne);
            }

            if (hostPort.HasValue || string.IsNullOrEmpty(scanDir))
            {
                if (config.Mode.Equals("PhotinoNet", StringComparison.OrdinalIgnoreCase))
                {
                    try
                    {
                        _logger.LogInformation("Starting Photino Desktop Host...");
                        // Start Web Server in background
                        _ = WebServer.StartAsync(config.Port, dbManager, previewManager, cameraManager, _loggerFactory, "localhost", configPath, "PhotinoNet");

                        // Initialize Photino Window
                        var window = new PhotinoWindow()
                            .SetTitle($"PhotoLibrary - {version}")
                            .SetUseOsDefaultSize(false)
                            .SetSize(new Size(1200, 800))
                            .Center()
                            .Load($"http://localhost:{config.Port}");

                        window.WaitForClose();
                    }
                    catch (Exception ex) when (ex.Message.Contains("Photino.Native") || ex is DllNotFoundException || ex.InnerException is DllNotFoundException)
                    {
                        Console.Error.WriteLine("\n[ERROR] Failed to start Photino Desktop Window.");
#if WINDOWS
                        Console.Error.WriteLine("Ensure that the Microsoft Edge WebView2 Runtime is installed.");
                        Console.Error.WriteLine("Download: https://developer.microsoft.com/en-us/microsoft-edge/webview2/");
#else
                        Console.Error.WriteLine("Missing native dependencies (likely WebKit2GTK 4.1).");
                        Console.Error.WriteLine("Try: sudo apt-get install libwebkit2gtk-4.1-0");
                        Console.Error.WriteLine("On older systems like Ubuntu 20.04, you may need to use WebHost mode instead.");
#endif
                        _logger.LogDebug(ex, "Photino Native Error");
                    }
                }
                else
                {
                    DisplayBanner(config.Port);
                    _logger.LogInformation("Starting Web Server on {BindAddr}:{Port}...", bindAddr, config.Port);
                    _logger.LogInformation("  Library: {LibraryPath}", finalLibraryPath);
                    _logger.LogInformation("  Previews: {PreviewDbPath}", finalPreviewDbPath);
                    await WebServer.StartAsync(config.Port, dbManager, previewManager, cameraManager, _loggerFactory, bindAddr, configPath, "WebHost");
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "An unexpected error occurred");
        }
    }

    private static void DisplayBanner(int port)
    {
        string blue = "\u001b[38;5;33m";
        string white = "\u001b[38;5;255m";
        string reset = "\u001b[0m";
        string bold = "\u001b[1m";

        Console.WriteLine();
        Console.WriteLine($"{blue}         ▄▄██████▄▄          {reset}");
        Console.WriteLine($"{blue}       ▄████████████▄        {reset}");
        Console.WriteLine($"{blue}      ▄██████████████▄       {reset}   {bold}PhotoLibrary{reset}");
        Console.WriteLine($"{blue}      ██████  {white}▄▄{blue}  ██████       {reset}   ----------------------------");
        Console.WriteLine($"{blue}      ████  {white}▄████▄{blue}  ████       {reset}   Point your browser to:");
        Console.WriteLine($"{blue}      ████  {white}▀████▀{blue}  ████       {reset}   {bold}http://localhost:{port}{reset}");
        Console.WriteLine($"{blue}      ██████  {white}▀▀{blue}  ██████       {reset}   ----------------------------");
        Console.WriteLine($"{blue}      ▀██████████████▀       {reset}");
        Console.WriteLine($"{blue}       ▀████████████▀        {reset}");
        Console.WriteLine($"{blue}         ▀▀██████▀▀          {reset}");
        Console.WriteLine();
    }
}