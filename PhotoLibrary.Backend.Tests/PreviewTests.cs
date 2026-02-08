using System;
using System.IO;
using System.Linq;
using ImageMagick;
using Microsoft.Extensions.Logging;
using Xunit;

namespace PhotoLibrary.Backend.Tests;

public class PreviewTests : TestBase
{
    private PreviewManager CreatePm()
    {
        var pm = new PreviewManager(PreviewDbPath, LoggerFactory.CreateLogger<PreviewManager>());
        pm.Initialize();
        return pm;
    }

    [Fact]
    public void SaveAndGet_ShouldWork()
    {
        // Arrange
        var pm = CreatePm();
        string hash = "test-hash-123";
        byte[] data = new byte[] { 1, 2, 3, 4 };

        // Act
        pm.SavePreview(hash, 300, data);
        var retrieved = pm.GetPreviewData(hash, 300);

        // Assert
        Assert.NotNull(retrieved);
        Assert.Equal(data, retrieved);
    }

    [Fact]
    public void DeletePreviewsByHash_ShouldRemoveAllSizes()
    {
        // Arrange
        var pm = CreatePm();
        string hash = "to-delete";
        pm.SavePreview(hash, 300, new byte[] { 1 });
        pm.SavePreview(hash, 1024, new byte[] { 2 });

        // Act
        pm.DeletePreviewsByHash(hash);

        // Assert
        Assert.Null(pm.GetPreviewData(hash, 300));
        Assert.Null(pm.GetPreviewData(hash, 1024));
    }

    [Fact]
    public void GeneratePreviews_ShouldDetectSidecar()
    {
        // Arrange
        var db = new DatabaseManager(DbPath, LoggerFactory.CreateLogger<DatabaseManager>());
        db.Initialize();
        var pm = CreatePm();
        
        string folder = Path.Combine(TestTempDir, "SidecarTest");
        Directory.CreateDirectory(folder);

        // Create a RAW file (just a small dummy)
        string rawPath = Path.Combine(folder, "test.ARW");
        File.WriteAllText(rawPath, "fake raw data");
        
        // Create its sidecar JPG
        string jpgPath = CreateTestImage("SidecarTest/test.jpg", width: 200, height: 200);

        var indexer = new ImageIndexer(db, LoggerFactory.CreateLogger<ImageIndexer>(), pm, new[] { 100 });
        
        // Register the RAW file in DB so PM can find its hash
        string rootId = db.GetOrCreateBaseRoot(TestTempDir);
        string childId = db.GetOrCreateChildRoot(rootId, "SidecarTest");
        db.UpsertFileEntry(new FileEntry { RootPathId = childId, FileName = "test.ARW", Hash = "raw-hash" });
        var fileId = db.GetFileId(childId, "test.ARW");

        // Act
        indexer.GeneratePreviews(new FileInfo(rawPath), fileId!);

        // Assert
        var preview = pm.GetPreviewData("raw-hash", 100);
        Assert.NotNull(preview);
        
        using (var img = new MagickImage(preview))
        {
            Assert.Equal(100u, Math.Max(img.Width, img.Height));
        }
    }
}
