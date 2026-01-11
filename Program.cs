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
        static async Task<int> Main(string[] args)
        {
            var rootCommand = new RootCommand("PhotoLibrary CLI - Scans and indexes photo metadata, and hosts a viewer");

            var libraryOption = new Option<string>(
                name: "--library",
                description: "Path to the SQLite database file")
            { IsRequired = true };

            var updateMdOption = new Option<string>(
                name: "--updatemd",
                description: "Directory to scan and update metadata for");
            // Made optional because we might just want to host

            var testOneOption = new Option<bool>(
                name: "--testone",
                description: "Only process one file and exit");

            var updatePreviewsOption = new Option<bool>(
                name: "--updatepreviews",
                description: "Generate previews for the scanned files");

            var previewDbOption = new Option<string>(
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

        static void Run(string libraryPath, string? scanDir, bool testOne, bool updatePreviews, string? previewDb, int[] longEdges, int? hostPort)
        {
            try
            {
                libraryPath = ResolvePath(libraryPath);
                if (!string.IsNullOrEmpty(previewDb))
                {
                    previewDb = ResolvePath(previewDb);
                }

                // CLI/Scanning Mode
                if (!string.IsNullOrEmpty(scanDir))
                {
                    scanDir = ResolvePath(scanDir);
                    Console.WriteLine($"Library: {libraryPath}");
                    Console.WriteLine($"Scanning: {scanDir}");
                    
                    var dbManager = new DatabaseManager(libraryPath);
                    dbManager.Initialize();

                    PreviewManager? previewManager = null;
                    if (updatePreviews && !string.IsNullOrEmpty(previewDb))
                    {
                        previewManager = new PreviewManager(previewDb);
                        previewManager.Initialize();
                    }

                    var scanner = new ImageScanner(dbManager, previewManager, longEdges);
                    scanner.Scan(scanDir, testOne);
                }

                // Hosting Mode
                if (hostPort.HasValue)
                {
                    if (string.IsNullOrEmpty(previewDb))
                    {
                        Console.WriteLine("Error: --previewdb is required for hosting mode.");
                        return;
                    }

                    Console.WriteLine($"Starting Web Server on port {hostPort.Value}...");
                    WebServer.Start(hostPort.Value, libraryPath, previewDb);
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