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
    public async Task GetDateTaken_ShouldHandleFallbacks()
    {
        // Arrange
        var (db, pm, cl) = CreateStack();
        
        string path = Path.Combine(TestTempDir, "no_meta.jpg");
        File.WriteAllText(path, "no metadata here");
        
        // Set both to same date to be 100% sure (GetDateTaken picks oldest)
        DateTime expectedDate = new DateTime(2010, 5, 15, 12, 0, 0);
        File.SetCreationTime(path, expectedDate);
        File.SetLastWriteTime(path, expectedDate);

        string targetRootId = db.GetOrCreateBaseRoot(Path.Combine(TestTempDir, "Library"));
        
        var req = new ImportLocalRequest(
            TestTempDir,
            new[] { "no_meta.jpg" },
            targetRootId,
            "{YYYY}-{MM}-{DD}",
            false, false, false
        );

        // Act
        cl.ImportLocal(req);

        // Assert
        string expectedDir = Path.Combine(TestTempDir, "Library", "2010-05-15");
        int attempts = 0;
        while (attempts++ < 50 && !Directory.Exists(expectedDir))
        {
            await Task.Delay(100);
        }
        
        Assert.True(Directory.Exists(expectedDir));
        Assert.True(File.Exists(Path.Combine(expectedDir, "no_meta.jpg")));
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

    [Fact]
    public async Task ImportLocal_ShouldPreventDuplicates()
    {
        // Arrange
        var (db, pm, cl) = CreateStack();
        
        string sourceRoot = Path.Combine(TestTempDir, "Source");
        Directory.CreateDirectory(sourceRoot);
        string sourceFile = CreateTestImage("Source/dup.jpg");
        
        string libraryPath = Path.Combine(TestTempDir, "Library");
        string targetRootId = db.GetOrCreateBaseRoot(libraryPath);

        // 1. First import
        var req = new ImportLocalRequest(sourceRoot, new[] { "dup.jpg" }, targetRootId, "", false, true, true);
        cl.ImportLocal(req);
        
        string expectedPath = Path.Combine(libraryPath, "dup.jpg");
        int attempts = 0;
        while (attempts++ < 50 && !File.Exists(expectedPath)) await Task.Delay(100);
        Assert.True(File.Exists(expectedPath));

        // 2. Second import (same file, same name)
        var req2 = new ImportLocalRequest(sourceRoot, new[] { "dup.jpg" }, targetRootId, "", false, true, true);
        cl.ImportLocal(req2);
        
        // Wait a bit to ensure it would have been processed
        await Task.Delay(1500);

        // Assert: Tree should still only have 1 image
        var tree = db.GetDirectoryTree().ToList();
        Assert.Equal(1, tree[0].ImageCount);

        // 3. Import different name but same content (Duplicate Hash)
        string sourceFile2 = Path.Combine(sourceRoot, "dup_alt.jpg");
        File.Copy(sourceFile, sourceFile2);
        
        var req3 = new ImportLocalRequest(sourceRoot, new[] { "dup_alt.jpg" }, targetRootId, "", false, true, true);
        cl.ImportLocal(req3);
        
        await Task.Delay(1500);

        // Assert: Tree should still only have 1 image because hash matched
        tree = db.GetDirectoryTree().ToList();
        Assert.Equal(1, tree[0].ImageCount);
        Assert.False(File.Exists(Path.Combine(libraryPath, "dup_alt.jpg")));
    }

    [Fact]
    public async Task Export_Originals_ShouldCreateZip()
    {
        // Arrange
        var (db, pm, cl) = CreateStack();
        
        string sourceDir = Path.Combine(TestTempDir, "Source");
        Directory.CreateDirectory(sourceDir);
        CreateTestImage("Source/photo1.jpg");
        CreateTestImage("Source/photo2.jpg");
        
        string rootId = db.GetOrCreateBaseRoot(sourceDir);
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "photo1.jpg", Hash = "h1" });
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "photo2.jpg", Hash = "h2" });
        
        var id1 = db.GetFileId(rootId, "photo1.jpg")!;
        var id2 = db.GetFileId(rootId, "photo2.jpg")!;

        var req = new ZipRequest(new[] { id1, id2 }, "originals", "MyExport");

        // Act
        string token = cl.PrepareExport(req);
        Assert.NotNull(token);
        Assert.Equal("MyExport_originals.zip", cl.GetExportZipName(token));

        using var ms = new MemoryStream();
        await cl.DownloadExport(token, ms);

        // Assert
        ms.Position = 0;
        using var archive = new System.IO.Compression.ZipArchive(ms);
        Assert.Equal(2, archive.Entries.Count);
        Assert.Contains(archive.Entries, e => e.Name == "photo1.jpg");
        Assert.Contains(archive.Entries, e => e.Name == "photo2.jpg");
    }

    [Fact]
    public async Task Export_ShouldHandleCollisions()
    {
        // Arrange
        var (db, pm, cl) = CreateStack();
        
        // Two files with same name but different roots
        string d1 = Path.Combine(TestTempDir, "Root1");
        string d2 = Path.Combine(TestTempDir, "Root2");
        Directory.CreateDirectory(d1);
        Directory.CreateDirectory(d2);
        
        File.WriteAllText(Path.Combine(d1, "dup.jpg"), "content1");
        File.WriteAllText(Path.Combine(d2, "dup.jpg"), "content2");

        string r1 = db.GetOrCreateBaseRoot(d1);
        string r2 = db.GetOrCreateBaseRoot(d2);
        
        db.UpsertFileEntry(new FileEntry { RootPathId = r1, FileName = "dup.jpg", Hash = "h1" });
        db.UpsertFileEntry(new FileEntry { RootPathId = r2, FileName = "dup.jpg", Hash = "h2" });
        
        var id1 = db.GetFileId(r1, "dup.jpg")!;
        var id2 = db.GetFileId(r2, "dup.jpg")!;

        var req = new ZipRequest(new[] { id1, id2 }, "originals", "CollisionTest");

        // Act
        string token = cl.PrepareExport(req);
        using var ms = new MemoryStream();
        await cl.DownloadExport(token, ms);

        // Assert
        ms.Position = 0;
        using var archive = new System.IO.Compression.ZipArchive(ms);
        Assert.Equal(2, archive.Entries.Count);
        Assert.Contains(archive.Entries, e => e.Name == "dup.jpg");
        Assert.Contains(archive.Entries, e => e.Name == "dup-1.jpg");
    }

    [Fact]
    public void GenerateThumbnails_ShouldEnqueueTasks()
    {
        // Arrange
        var (db, pm, cl) = CreateStack();
        string rootPath = Path.Combine(TestTempDir, "EnqTest");
        Directory.CreateDirectory(rootPath);
        CreateTestImage("EnqTest/p1.jpg");
        CreateTestImage("EnqTest/p2.jpg");
        
        string rootId = db.GetOrCreateBaseRoot(rootPath);
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "p1.jpg", Hash = "h1", BaseName = "p1" });
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "p2.jpg", Hash = "h2", BaseName = "p2" });

        var enqueued = new ConcurrentBag<ImageRequest>();

        // Act
        cl.GenerateThumbnails(new GenerateThumbnailsRequest(rootId, false, false), (req, ct) => {
            enqueued.Add(req);
        });

        // Wait for background scan/enqueue
        int attempts = 0;
        while (attempts++ < 50 && enqueued.Count < 4) Thread.Sleep(100);

        // Assert
        Assert.Equal(4, enqueued.Count);
        var f1 = db.GetFileId(rootId, "p1.jpg");
        Assert.Contains(enqueued, r => r.fileEntryId == f1 && r.size == 300);
        Assert.Contains(enqueued, r => r.fileEntryId == f1 && r.size == 1024);
    }

    [Fact]
    public void GenerateThumbnails_StackedJpgOnly_ShouldFilterCorrectly()
    {
        // Arrange
        var (db, pm, cl) = CreateStack();
        string rootPath = Path.Combine(TestTempDir, "FilterTest");
        Directory.CreateDirectory(rootPath);
        CreateTestImage("FilterTest/s1.jpg");
        CreateTestImage("FilterTest/s1.ARW");
        CreateTestImage("FilterTest/u1.jpg");
        
        string rootId = db.GetOrCreateBaseRoot(rootPath);
        // Stacked (s1.jpg and s1.ARW)
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "s1.jpg", Hash = "h1", BaseName = "s1" });
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "s1.ARW", Hash = "h2", BaseName = "s1" });
        // Unstacked
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "u1.jpg", Hash = "h3", BaseName = "u1" });

        var enqueued = new ConcurrentBag<ImageRequest>();

        // Act - Request Stacked JPG Only
        cl.GenerateThumbnails(new GenerateThumbnailsRequest(rootId, false, false, true, ".jpg"), (req, ct) => {
            enqueued.Add(req);
        });

        // Wait for background scan/enqueue
        int attempts = 0;
        while (attempts++ < 50 && enqueued.Count < 2) Thread.Sleep(100);

        // Assert
        Assert.Equal(2, enqueued.Count); // Only s1.jpg (300 and 1024)
        var s1Id = db.GetFileId(rootId, "s1.jpg");
        Assert.All(enqueued, r => Assert.Equal(s1Id, r.fileEntryId));
    }

    [Fact]
    public void ForceUpdatePreview_ShouldDeleteAndEnqueue()
    {
        // Arrange
        var (db, pm, cl) = CreateStack();
        string rootId = db.GetOrCreateBaseRoot("/test");
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "force.jpg", Hash = "fh1" });
        var fileId = db.GetFileId(rootId, "force.jpg")!;
        
        // Mock a preview exists
        pm.SavePreview("fh1", 300, new byte[] { 1 });
        Assert.True(pm.HasPreview("fh1", 300));

        var enqueued = new List<ImageRequest>();

        // Act
        cl.ForceUpdatePreview(new ForceUpdatePreviewRequest(fileId), (req, ct) => enqueued.Add(req));

        // Assert
        Assert.False(pm.HasPreview("fh1", 300)); // Should be deleted
        Assert.Equal(2, enqueued.Count);
        Assert.Contains(enqueued, r => r.size == 300);
        Assert.Contains(enqueued, r => r.size == 1024);
    }

    [Fact]
    public void ReadTrackingStream_ShouldCountBytes()
    {
        // Arrange
        long counted = 0;
        byte[] data = new byte[1024];
        new Random().NextBytes(data);
        using var ms = new MemoryStream(data);
        using var stream = new ReadTrackingStream(ms, b => counted += b);

        // Act
        byte[] buffer = new byte[512];
        int read1 = stream.Read(buffer, 0, 512);
        int read2 = stream.Read(buffer, 0, 100);

        // Assert
        Assert.Equal(512, read1);
        Assert.Equal(100, read2);
        Assert.Equal(612, counted);
    }
}
