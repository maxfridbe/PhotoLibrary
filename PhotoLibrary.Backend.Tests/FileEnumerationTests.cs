using System;
using System.IO;
using System.Linq;
using Xunit;

namespace PhotoLibrary.Backend.Tests;

public class FileEnumerationTests : IDisposable
{
    private readonly string _tempRoot;

    public FileEnumerationTests()
    {
        _tempRoot = Path.Combine(Path.GetTempPath(), "PL_EnumTests_" + Guid.NewGuid());
        Directory.CreateDirectory(_tempRoot);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempRoot))
        {
            try { Directory.Delete(_tempRoot, true); } catch { }
        }
    }

    [Fact]
    public void EnumerateFiles_ShouldFindDeepFiles()
    {
        // Arrange
        Directory.CreateDirectory(Path.Combine(_tempRoot, "FolderA"));
        Directory.CreateDirectory(Path.Combine(_tempRoot, "FolderB", "SubFolderB"));
        
        File.WriteAllText(Path.Combine(_tempRoot, "root.txt"), "content");
        File.WriteAllText(Path.Combine(_tempRoot, "FolderA", "a.jpg"), "content");
        File.WriteAllText(Path.Combine(_tempRoot, "FolderB", "b.png"), "content");
        File.WriteAllText(Path.Combine(_tempRoot, "FolderB", "SubFolderB", "deep.ARW"), "content");

        var options = new EnumerationOptions { 
            IgnoreInaccessible = true, 
            RecurseSubdirectories = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System 
        };

        // Act
        var files = Directory.EnumerateFiles(_tempRoot, "*", options).ToList();

        // Assert
        Assert.Contains(files, f => f.EndsWith("root.txt"));
        Assert.Contains(files, f => f.EndsWith("a.jpg"));
        Assert.Contains(files, f => f.EndsWith("b.png"));
        Assert.Contains(files, f => f.EndsWith("deep.ARW"));
        Assert.Equal(4, files.Count);
    }

    [Fact]
    public void EnumerateFiles_ShouldSkipHiddenFiles_WhenConfigured()
    {
        // Arrange
        var hiddenFile = Path.Combine(_tempRoot, "hidden.jpg");
        File.WriteAllText(hiddenFile, "secret");
        
        // Set hidden attribute
        // This might fail on some Linux file systems if not supported, but usually works in .NET abstraction or prepended with .
        // On Linux .NET treats files starting with '.' as hidden if using enumeration options? 
        // No, FileAttributes.Hidden on Linux usually maps to '.' prefix OR file attribute if FS supports it.
        // Let's try the '.' prefix convention which is standard on Linux.
        
        var dotHiddenFile = Path.Combine(_tempRoot, ".dothidden.jpg");
        File.WriteAllText(dotHiddenFile, "dot secret");

        var normalFile = Path.Combine(_tempRoot, "normal.jpg");
        File.WriteAllText(normalFile, "normal");

        var options = new EnumerationOptions { 
            IgnoreInaccessible = true, 
            RecurseSubdirectories = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System 
        };

        // Act
        var files = Directory.EnumerateFiles(_tempRoot, "*", options).ToList();

        // Assert
        Assert.Contains(files, f => f.EndsWith("normal.jpg"));
        
        // On Linux, default EnumerationOptions might not skip dot files unless they are considered "Hidden" by attributes.
        // .NET on Unix: FileAttributes.Hidden is set if the filename starts with a period.
        Assert.DoesNotContain(files, f => f.EndsWith(".dothidden.jpg"));
    }

    [Fact]
    public void EnumerateFiles_ShouldNotCrash_OnInaccessibleDirectories()
    {
        // This test attempts to simulate an inaccessible directory.
        // On Linux/Unix we can try to remove read permissions.
        
        var lockedDir = Path.Combine(_tempRoot, "Locked");
        Directory.CreateDirectory(lockedDir);
        File.WriteAllText(Path.Combine(lockedDir, "canttouchthis.jpg"), "content");

        try
        {
            // Remove read/execute permissions for current user
            // chmod 000
            File.SetUnixFileMode(lockedDir, UnixFileMode.None);
        }
        catch (PlatformNotSupportedException)
        {
            // Skip if on Windows or FS doesn't support it
            return; 
        }

        var options = new EnumerationOptions { 
            IgnoreInaccessible = true, 
            RecurseSubdirectories = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System 
        };

        try 
        {
            // Act
            var files = Directory.EnumerateFiles(_tempRoot, "*", options).ToList();

            // Assert
            // Should not have thrown.
            // Should verify we didn't find the file inside locked dir (since we couldn't enter)
            Assert.DoesNotContain(files, f => f.EndsWith("canttouchthis.jpg"));
        }
        finally
        {
            // Cleanup: restore permissions so we can delete it
            try { File.SetUnixFileMode(lockedDir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute); } catch {}
        }
    }
}
