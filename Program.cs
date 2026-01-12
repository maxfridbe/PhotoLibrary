using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.CommandLine;
using System.CommandLine.Invocation;
using System.IO;
using System.Threading.Tasks;

namespace PhotoLibrary
{
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
        }

        static async Task<int> Main(string[] args)
        {
            var rootCommand = new RootCommand("PhotoLibrary CLI - Scans and indexes photo metadata, and hosts a viewer");

            var libraryOption = new Option<string?>(
                name: "--library",
                description: "Path to the SQLite database file");

            var updateMdOption = new Option<string?>(
                name: "--updatemd",
                description: "Directory to scan and update metadata for");

            var testOneOption = new Option<bool>(
                name: "--testone",
                description: "Only process one file and exit");

            var updatePreviewsOption = new Option<bool>(
                name: "--updatepreviews",
                description: "Generate previews for the scanned files");

            var previewDbOption = new Option<string?>(
                name: "--previewdb",
                description: "Path to the SQLite database for previews");

            var longEdgeOption = new Option<int[]>(
                name: "--longedge",
                description: "Long edge size for previews (can be specified multiple times)")
            { AllowMultipleArgumentsPerToken = true };

            var hostOption = new Option<int?>(
                name: "--host",
                description: "Port to host the web viewer on (e.g., 8080)");

            rootCommand.AddOption(libraryOption);
            rootCommand.AddOption(updateMdOption);
            rootCommand.AddOption(testOneOption);
            rootCommand.AddOption(updatePreviewsOption);
            rootCommand.AddOption(previewDbOption);
            rootCommand.AddOption(longEdgeOption);
            rootCommand.AddOption(hostOption);

            rootCommand.SetHandler((libraryPath, scanDir, testOne, updatePreviews, previewDb, longEdges, hostPort) =>
            {
                Run(libraryPath, scanDir, testOne, updatePreviews, previewDb, longEdges, hostPort);
            }, libraryOption, updateMdOption, testOneOption, updatePreviewsOption, previewDbOption, longEdgeOption, hostOption);

            return await rootCommand.InvokeAsync(args);
        }

        static void Run(string? libraryPath, string? scanDir, bool testOne, bool updatePreviews, string? previewDb, int[] longEdges, int? hostPort)
        {
            try
            {
                string configDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "PhotoLibrary");
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
                        Bind = "localhost"
                    };
                }

                // Apply CLI overrides to config object
                if (!string.IsNullOrEmpty(libraryPath)) config.LibraryPath = PathUtils.ResolvePath(libraryPath);
                if (!string.IsNullOrEmpty(previewDb)) config.PreviewDbPath = PathUtils.ResolvePath(previewDb);
                if (hostPort.HasValue) config.Port = hostPort.Value;

                // If paths are still null (shouldn't happen with defaults but safety first)
                if (string.IsNullOrEmpty(config.LibraryPath)) config.LibraryPath = Path.Combine(configDir, "library.db");
                if (string.IsNullOrEmpty(config.PreviewDbPath)) config.PreviewDbPath = Path.Combine(configDir, "previews.db");

                // Save updated config
                File.WriteAllText(configPath, System.Text.Json.JsonSerializer.Serialize(config, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));

                string finalLibraryPath = PathUtils.ResolvePath(config.LibraryPath);
                string finalPreviewDbPath = PathUtils.ResolvePath(config.PreviewDbPath);
                string bindAddr = config.Bind == "public" ? "*" : "localhost";

                var dbManager = new DatabaseManager(finalLibraryPath, _loggerFactory.CreateLogger<DatabaseManager>());
                dbManager.Initialize();

                PreviewManager? previewManager = null;
                // Pre-init preview manager if path is known
                previewManager = new PreviewManager(finalPreviewDbPath, _loggerFactory.CreateLogger<PreviewManager>());
                previewManager.Initialize();

                // CLI/Scanning Mode
                if (!string.IsNullOrEmpty(scanDir))
                {
                    scanDir = PathUtils.ResolvePath(scanDir);
                    _logger.LogInformation("Library: {LibraryPath}", finalLibraryPath);
                    _logger.LogInformation("Scanning: {ScanDir}", scanDir);
                    
                    var indexer = new ImageIndexer(dbManager, _loggerFactory.CreateLogger<ImageIndexer>(), previewManager, longEdges);
                    indexer.Scan(scanDir, testOne);
                }

                // Hosting Mode (Always run if no scanDir, or if explicit hostPort)
                if (hostPort.HasValue || string.IsNullOrEmpty(scanDir))
                {
                    _logger.LogInformation("Starting Web Server on {BindAddr}:{Port}...", bindAddr, config.Port);
                    _logger.LogInformation("  Library: {LibraryPath}", finalLibraryPath);
                    _logger.LogInformation("  Previews: {PreviewDbPath}", finalPreviewDbPath);
                    WebServer.Start(config.Port, dbManager, previewManager, _loggerFactory, bindAddr);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "An unexpected error occurred");
            }
        }
    }
}
