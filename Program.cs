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

            var testOneOption = new Option<bool>(
                name: "--testone",
                description: "Only process one file and exit");

            rootCommand.AddOption(libraryOption);
            rootCommand.AddOption(updateMdOption);
            rootCommand.AddOption(testOneOption);

            rootCommand.SetHandler((libraryPath, scanDir, testOne) =>
            {
                RunScan(libraryPath, scanDir, testOne);
            }, libraryOption, updateMdOption, testOneOption);

            return await rootCommand.InvokeAsync(args);
        }

        static void RunScan(string libraryPath, string scanDir, bool testOne)
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
                if (testOne) Console.WriteLine("Test One Mode: Active");

                var dbManager = new DatabaseManager(libraryPath);
                dbManager.Initialize();

                var scanner = new ImageScanner(dbManager);
                scanner.Scan(scanDir, testOne);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"An error occurred: {ex.Message}");
                Console.WriteLine(ex.StackTrace);
            }
        }
    }
}