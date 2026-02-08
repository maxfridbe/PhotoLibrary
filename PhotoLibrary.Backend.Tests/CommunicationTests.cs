using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Xunit;

namespace PhotoLibrary.Backend.Tests;

public class CommunicationTests : TestBase
{
    private (DatabaseManager, PreviewManager, CommunicationLayer) CreateStack()
    {
        var db = new DatabaseManager(DbPath, LoggerFactory.CreateLogger<DatabaseManager>());
        db.Initialize();
        
        var pm = new PreviewManager(PreviewDbPath, LoggerFactory.CreateLogger<PreviewManager>());
        pm.Initialize();

        var cl = new CommunicationLayer(
            db, 
            pm, 
            null!, 
            LoggerFactory, 
            Path.Combine(TestTempDir, "config.json"),
            msg => Task.CompletedTask,
            new ConcurrentDictionary<string, CancellationTokenSource>()
        );
        return (db, pm, cl);
    }

    [Fact]
    public async Task ImportLocal_ShouldFollowTemplateAndIndex()
    {
        // Arrange
        var (db, pm, cl) = CreateStack();
        
        string sourceRoot = Path.Combine(TestTempDir, "CameraCard");
        string sourceFile = CreateTestImage("CameraCard/DSC001.jpg", configure: img => {
            var profile = new ImageMagick.ExifProfile();
            // Set date to 2022-05-20
            profile.SetValue(ImageMagick.ExifTag.DateTimeOriginal, "2022:05:20 12:00:00");
            img.SetProfile(profile);
        });

        string targetRootId = db.GetOrCreateBaseRoot(TestTempDir);

        var req = new ImportLocalRequest(
            sourceRoot,
            new[] { "DSC001.jpg" },
            targetRootId,
            "MyLibrary/{YYYY}/{MM}/{DD}",
            true,
            true,
            true
        );

        // Act
        cl.ImportLocal(req);

        // Wait for background task
        string expectedPath = Path.Combine(TestTempDir, "MyLibrary", "2022/05/20/DSC001.jpg");
        int attempts = 0;
        while (attempts++ < 50 && !File.Exists(expectedPath))
        {
            await Task.Delay(100);
        }

        // Assert
        Assert.True(File.Exists(expectedPath));

        var tree = db.GetDirectoryTree().ToList();
        
        Func<IEnumerable<DirectoryNodeResponse>, string, DirectoryNodeResponse?> findRecId = null!;
        findRecId = (nodes, id) => {
            foreach(var n in nodes) {
                if (n.DirectoryId == id) return n;
                var r = findRecId(n.Children, id);
                if (r != null) return r;
            }
            return null;
        };

        var libraryNode = findRecId(tree, targetRootId);
        Assert.NotNull(libraryNode);
        
        // Check recursive count (from previous feature)
        Assert.Equal(1, libraryNode.ImageCount);
    }

    [Fact]
    public void ValidateImport_ShouldDetectExistingFiles()
    {
        // Arrange
        var (db, pm, cl) = CreateStack();
        
        string libraryPath = Path.Combine(TestTempDir, "Library");
        Directory.CreateDirectory(libraryPath);
        File.WriteAllText(Path.Combine(libraryPath, "exists.jpg"), "content");
        
        string rootId = db.GetOrCreateBaseRoot(libraryPath);

        var req = new ValidateImportRequest(
            rootId,
            new System.Collections.Generic.Dictionary<string, string> {
                { "source/new.jpg", "new.jpg" },
                { "source/old.jpg", "exists.jpg" }
            }
        );

        // Act
        var result = cl.ValidateImport(req);

        // Assert
        Assert.Contains("source/old.jpg", result.ExistingSourceFiles);
        Assert.Single(result.ExistingSourceFiles);
    }
}
