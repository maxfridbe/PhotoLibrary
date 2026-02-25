using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PhotoLibrary.Backend;

namespace PhotoLibrary.TestHarness;

public class Program {
    public static void Main(string[] args) {
        // Setup infrastructure
        string dbPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config/PhotoLibrary/library.db");
        var loggerFactory = LoggerFactory.Create(builder => {
            builder.AddConsole();
            builder.SetMinimumLevel(LogLevel.Debug);
        });
        
        var db = new DatabaseManager(dbPath, loggerFactory.CreateLogger<DatabaseManager>());
        var pm = new PathManager();

        Console.WriteLine("--- PhotoLibrary Test Harness ---");
        
        // TODO: Put whatever you want to test in the backend here
        
        Console.WriteLine("--- Done ---");
    }
}
