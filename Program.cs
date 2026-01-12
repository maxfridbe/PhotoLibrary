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
                AppConfig? config = null;

                if (File.Exists(configPath))
                {
                    try {
                        config = System.Text.Json.JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(configPath));
                    } catch { }
                }

                if (config == null)
                {
                    Directory.CreateDirectory(configDir);
                    config = new AppConfig {
                        LibraryPath = Path.Combine(configDir, "library.db"),
                        PreviewDbPath = Path.Combine(configDir, "previews.db"),
                        Port = 8080,
                        Bind = "localhost"
                    };
                    File.WriteAllText(configPath, System.Text.Json.JsonSerializer.Serialize(config, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
                }

                // CLI overrides or defaults
                libraryPath = libraryPath ?? config.LibraryPath;
                previewDb = previewDb ?? config.PreviewDbPath;
                int finalPort = hostPort ?? config.Port;
                string bindAddr = config.Bind == "public" ? "*" : "localhost";

                if (string.IsNullOrEmpty(libraryPath)) throw new Exception("Library path is missing.");
                if (string.IsNullOrEmpty(previewDb)) throw new Exception("Preview DB path is missing.");

                libraryPath = ResolvePath(libraryPath);
                previewDb = ResolvePath(previewDb);

                // CLI/Scanning Mode
                if (!string.IsNullOrEmpty(scanDir))
                {
                    scanDir = ResolvePath(scanDir);
                    Console.WriteLine($"Library: {libraryPath}");
                    Console.WriteLine($"Scanning: {scanDir}");
                    
                    var dbManager = new DatabaseManager(libraryPath);
                    dbManager.Initialize();

                    PreviewManager? previewManager = null;
                    if (updatePreviews)
                    {
                        previewManager = new PreviewManager(previewDb);
                        previewManager.Initialize();
                    }

                    var scanner = new ImageScanner(dbManager, previewManager, longEdges);
                    scanner.Scan(scanDir, testOne);
                }

                // Hosting Mode (Always run if no scanDir, or if explicit hostPort)
                if (hostPort.HasValue || string.IsNullOrEmpty(scanDir))
                {
                    Console.WriteLine($"Starting Web Server on {bindAddr}:{finalPort}...");
                    Console.WriteLine($"  Library: {libraryPath}");
                    Console.WriteLine($"  Previews: {previewDb}");
                    WebServer.Start(finalPort, libraryPath, previewDb, bindAddr);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"An error occurred: {ex.Message}");
                Console.WriteLine(ex.StackTrace);
            }
        }

        static string ResolvePath(string path)
        {
            if (path.StartsWith("~"))
            {
                return path.Replace("~", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            }
            return Path.GetFullPath(path);
        }
    }
}