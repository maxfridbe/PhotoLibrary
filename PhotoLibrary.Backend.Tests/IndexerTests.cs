using System;
using System.IO;
using System.Linq;
using ImageMagick;
using Microsoft.Extensions.Logging;
using Xunit;

namespace PhotoLibrary.Backend.Tests;

public class IndexerTests : TestBase
{
    [Fact]
    public void Scan_ShouldIndexNewFiles()
    {
        // Arrange
        var db = new DatabaseManager(DbPath, LoggerFactory.CreateLogger<DatabaseManager>());
        db.Initialize();
        
        string scanDir = Path.Combine(TestTempDir, "Source");
        Directory.CreateDirectory(scanDir);
        
        CreateTestImage("Source/image1.jpg");
        CreateTestImage("Source/Sub/image2.jpg");

        var indexer = new ImageIndexer(db, LoggerFactory.CreateLogger<ImageIndexer>());

        // Act
        indexer.Scan(scanDir);

        // Assert
        var tree = db.GetDirectoryTree().ToList();
        Assert.NotEmpty(tree);
        Assert.Equal(2, tree.Sum(r => r.ImageCount));
    }

    [Fact]
    public void MetadataExtraction_ShouldReadExif()
    {
        // Arrange
        var db = new DatabaseManager(DbPath, LoggerFactory.CreateLogger<DatabaseManager>());
        db.Initialize();
        
        string imagePath = CreateTestImage("meta.jpg", configure: img => {
            var profile = new ExifProfile();
            profile.SetValue(ExifTag.Model, "TestCamera123");
            img.SetProfile(profile);
        });

        var indexer = new ImageIndexer(db, LoggerFactory.CreateLogger<ImageIndexer>());

        // Act
        indexer.ProcessSingleFile(new FileInfo(imagePath), TestTempDir);

        // Assert
        var tree = db.GetDirectoryTree().ToList();
        Assert.NotEmpty(tree);
        var fileId = db.GetFileIdsUnderRoot(tree[0].DirectoryId, true).First();
        var metadata = db.GetMetadata(fileId);
        Assert.Contains(metadata, m => m.Tag == "Model" && m.Value == "TestCamera123");
    }

    [Fact]
    public void ProcessSingleFileFromSource_ShouldRecordTargetCorrectly()
    {
        // Arrange
        var db = new DatabaseManager(DbPath, LoggerFactory.CreateLogger<DatabaseManager>());
        db.Initialize();
        
        // Image exists at Source, but we want it indexed at Target
        string sourcePath = CreateTestImage("PhysicalSource/real.jpg");
        string libraryRoot = Path.Combine(TestTempDir, "Library");
        string targetPath = Path.Combine(libraryRoot, "2023/imported.jpg");
        
        var indexer = new ImageIndexer(db, LoggerFactory.CreateLogger<ImageIndexer>());

        // Act
        indexer.ProcessSingleFileFromSource(new FileInfo(sourcePath), targetPath, libraryRoot);

        // Assert
        var tree = db.GetDirectoryTree().ToList();
        
        Func<IEnumerable<DirectoryNodeResponse>, string, DirectoryNodeResponse?> findRec = null!;
        findRec = (nodes, name) => {
            foreach(var n in nodes) {
                if (n.Name == name) return n;
                var r = findRec(n.Children, name);
                if (r != null) return r;
            }
            return null;
        };

        var targetNode = findRec(tree, "2023");
        Assert.NotNull(targetNode);
        
        var fileId = db.GetFileId(targetNode.DirectoryId, "imported.jpg");
        Assert.NotNull(fileId);
        
        var fullPath = db.GetFullFilePath(fileId);
        Assert.Equal(targetPath, fullPath);
    }

    [Fact]
    public void Hashing_ShouldBeConsistent()
    {
        // Arrange
        var db = new DatabaseManager(DbPath, LoggerFactory.CreateLogger<DatabaseManager>());
        db.Initialize();
        var pm = new PreviewManager(PreviewDbPath, LoggerFactory.CreateLogger<PreviewManager>());
        pm.Initialize();
        var indexer = new ImageIndexer(db, LoggerFactory.CreateLogger<ImageIndexer>(), pm, new[] { 300 });
        
        string content = "fake image data content";
        
        string path1 = Path.Combine(TestTempDir, "h1.jpg");
        File.WriteAllText(path1, content);
        
        string path2 = Path.Combine(TestTempDir, "h2.jpg");
        File.WriteAllText(path2, content);

        // Act
        indexer.ProcessSingleFile(new FileInfo(path1), TestTempDir);
        indexer.ProcessSingleFile(new FileInfo(path2), TestTempDir);

        // Assert
        var tree = db.GetDirectoryTree().ToList();
        
        Func<IEnumerable<DirectoryNodeResponse>, string, string?> findFileId = null!;
        findFileId = (nodes, name) => {
            foreach(var n in nodes) {
                var id = db.GetFileId(n.DirectoryId, name);
                if (id != null) return id;
                var rid = findFileId(n.Children, name);
                if (rid != null) return rid;
            }
            return null;
        };

        var id1 = findFileId(tree, "h1.jpg");
        var id2 = findFileId(tree, "h2.jpg");
        
        Assert.NotNull(id1);
        Assert.NotNull(id2);
        
        string? hash1 = db.GetFileHash(id1!);
        string? hash2 = db.GetFileHash(id2!);
        
        Assert.NotNull(hash1);
        Assert.Equal(hash1, hash2);

        // Verify different content gives different hash
        string path3 = Path.Combine(TestTempDir, "h3.jpg");
        File.WriteAllText(path3, content + "suffix");
        indexer.ProcessSingleFile(new FileInfo(path3), TestTempDir);
        var id3 = findFileId(tree, "h3.jpg");
        string? hash3 = db.GetFileHash(id3!);
        
        Assert.NotEqual(hash1, hash3);
    }
}
