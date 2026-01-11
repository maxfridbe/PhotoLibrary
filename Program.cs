using System;
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

            rootCommand.AddOption(libraryOption);
            rootCommand.AddOption(updateMdOption);

            rootCommand.SetHandler((libraryPath, scanDir) =>
            {
                RunScan(libraryPath, scanDir);
            }, libraryOption, updateMdOption);

            return await rootCommand.InvokeAsync(args);
        }

        static void RunScan(string libraryPath, string scanDir)
        {
            try
            {
                // Resolve paths
                if (libraryPath.StartsWith("~"))
                {
                    libraryPath = libraryPath.Replace("~", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
                }
                
                if (scanDir.StartsWith("~"))
                {
                    scanDir = scanDir.Replace("~", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
                }

                scanDir = Path.GetFullPath(scanDir);
                
                Console.WriteLine($"Library: {libraryPath}");
                Console.WriteLine($"Scanning: {scanDir}");

                var dbManager = new DatabaseManager(libraryPath);
                dbManager.Initialize();

                var scanner = new ImageScanner(dbManager);
                scanner.Scan(scanDir);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"An error occurred: {ex.Message}");
                Console.WriteLine(ex.StackTrace);
            }
        }
    }
}