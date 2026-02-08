using System;
using System.IO;
using ImageMagick;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace PhotoLibrary.Backend.Tests;

public abstract class TestBase : IDisposable
{
    protected readonly string TestTempDir;
    protected readonly string DbPath;
    protected readonly string PreviewDbPath;
    protected readonly ILoggerFactory LoggerFactory;

    protected TestBase()
    {
        TestTempDir = Path.Combine(Path.GetTempPath(), "PhotoLibrary_Tests_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(TestTempDir);

        DbPath = Path.Combine(TestTempDir, "library.db");
        PreviewDbPath = Path.Combine(TestTempDir, "previews.db");
        
        LoggerFactory = new NullLoggerFactory();
    }

    protected string CreateTestImage(string relativePath, int width = 100, int height = 100, Action<MagickImage>? configure = null)
    {
        string fullPath = Path.Combine(TestTempDir, relativePath);
        string? dir = Path.GetDirectoryName(fullPath);
        if (dir != null && !Directory.Exists(dir)) Directory.CreateDirectory(dir);

        using (var image = new MagickImage(MagickColors.Black, (uint)width, (uint)height))
        {
            image.Format = MagickFormat.Jpg;
            configure?.Invoke(image);
            image.Write(fullPath);
        }

        return fullPath;
    }

    public virtual void Dispose()
    {
        if (Directory.Exists(TestTempDir))
        {
            try
            {
                // Give SQLite a moment to close connections if needed
                GC.Collect();
                GC.WaitForPendingFinalizers();
                Directory.Delete(TestTempDir, true);
            }
            catch
            {
                // Best effort cleanup
            }
        }
    }
}
