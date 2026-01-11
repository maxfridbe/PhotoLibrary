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
            var rootCommand = new RootCommand("PhotoLibrary CLI - Scans and indexes photo metadata");

            var libraryOption = new Option<string>(
                name: "--library",
                description: "Path to the SQLite database file")
            { IsRequired = true };

            var updateMdOption = new Option<string>(
                name: "--updatemd",
                description: "Directory to scan and update metadata for")
            { IsRequired = true };

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

            rootCommand.AddOption(libraryOption);
            rootCommand.AddOption(updateMdOption);
            rootCommand.AddOption(testOneOption);
            rootCommand.AddOption(updatePreviewsOption);
            rootCommand.AddOption(previewDbOption);
            rootCommand.AddOption(longEdgeOption);

            rootCommand.SetHandler((libraryPath, scanDir, testOne, updatePreviews, previewDb, longEdges) =>
            {
                RunScan(libraryPath, scanDir, testOne, updatePreviews, previewDb, longEdges);
            }, libraryOption, updateMdOption, testOneOption, updatePreviewsOption, previewDbOption, longEdgeOption);

            return await rootCommand.InvokeAsync(args);
        }

        static void RunScan(string libraryPath, string scanDir, bool testOne, bool updatePreviews, string previewDb, int[] longEdges)
        {
            try
            {
                // Resolve paths
                libraryPath = ResolvePath(libraryPath);
                scanDir = ResolvePath(scanDir);
                if (!string.IsNullOrEmpty(previewDb))
                {
                    previewDb = ResolvePath(previewDb);
                }

                Console.WriteLine($"Library: {libraryPath}");
                Console.WriteLine($"Scanning: {scanDir}");
                if (testOne) Console.WriteLine("Test One Mode: Active");
                if (updatePreviews)
                {
                    Console.WriteLine("Update Previews: Active");
                    Console.WriteLine($"Preview DB: {previewDb}");
                    Console.WriteLine($"Sizes: {string.Join(", ", longEdges)}");
                }

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
