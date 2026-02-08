using System;
using System.IO;
using System.Linq;
using Microsoft.Extensions.Logging;
using Xunit;

namespace PhotoLibrary.Backend.Tests;

public class DatabaseTests : TestBase
{
    private DatabaseManager CreateDb()
    {
        var db = new DatabaseManager(DbPath, LoggerFactory.CreateLogger<DatabaseManager>());
        db.Initialize();
        return db;
    }

    [Fact]
    public void Initialize_ShouldCreateSchema()
    {
        // Act
        var db = CreateDb();

        // Assert
        Assert.True(File.Exists(DbPath));
        
        using var conn = db.GetOpenConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name='RootPaths'";
        var result = cmd.ExecuteScalar();
        Assert.Equal("RootPaths", result);
    }

    [Fact]
    public void RootManagement_ShouldHandleHierarchies()
    {
        // Arrange
        var db = CreateDb();
        string baseDir = TestTempDir;

        // Act
        string baseId = db.GetOrCreateBaseRoot(baseDir);
        string childId = db.GetOrCreateChildRoot(baseId, "2023");
        string grandchildId = db.GetOrCreateChildRoot(childId, "Trip");

        // Assert
        Assert.NotNull(baseId);
        Assert.NotNull(childId);
        Assert.NotNull(grandchildId);

        var tree = db.GetDirectoryTree().ToList();
        Assert.Single(tree);
        // On some systems/test environments, the name might be just the end of the path or the whole path.
        // GetOrCreateBaseRoot uses the whole absolute path.
        Assert.Contains("PhotoLibrary_Tests_", tree[0].Name);
        Assert.Single(tree[0].Children);
        Assert.Equal("2023", tree[0].Children[0].Name);
        Assert.Single(tree[0].Children[0].Children);
        Assert.Equal("Trip", tree[0].Children[0].Children[0].Name);
    }

    private string normalizePath(string p) => p.Replace("\\", "/").TrimEnd('/');

    [Fact]
    public void UpsertFileEntry_ShouldInsertAndUpdate()
    {
        // Arrange
        var db = CreateDb();
        string baseId = db.GetOrCreateBaseRoot("/test");
        var entry = new FileEntry
        {
            RootPathId = baseId,
            FileName = "test.jpg",
            Size = 1024,
            Hash = "abc",
            CreatedAt = DateTime.Now,
            ModifiedAt = DateTime.Now
        };

        // Act: Insert
        db.UpsertFileEntry(entry);
        var id = db.GetFileId(baseId, "test.jpg");
        Assert.NotNull(id);

        // Act: Update
        entry.Size = 2048;
        entry.Hash = "def";
        db.UpsertFileEntry(entry);

        // Assert
        var updatedHash = db.GetFileHash(id);
        Assert.Equal("def", updatedHash);
        
        var (path, rotation, isHidden) = db.GetExportInfo(id);
        Assert.Contains("test.jpg", path);
    }

    [Fact]
    public void ForgetRoot_ShouldDeleteRecursively()
    {
        // Arrange
        var db = CreateDb();
        string baseId = db.GetOrCreateBaseRoot("/to-forget");
        string childId = db.GetOrCreateChildRoot(baseId, "sub");
        
        db.UpsertFileEntry(new FileEntry { RootPathId = baseId, FileName = "root.jpg", Hash = "h1" });
        db.UpsertFileEntry(new FileEntry { RootPathId = childId, FileName = "child.jpg", Hash = "h2" });

        var rootFileId = db.GetFileId(baseId, "root.jpg");
        db.InsertMetadata(rootFileId!, new[] { new MetadataItem { Directory = "Exif", Tag = "Model", Value = "Test" } });

        // Act
        db.ForgetRoot(baseId);

        // Assert
        var tree = db.GetDirectoryTree();
        Assert.Empty(tree);
        
        Assert.Null(db.GetFileId(baseId, "root.jpg"));
        Assert.Null(db.GetFileId(childId, "child.jpg"));
        Assert.Empty(db.GetMetadata(rootFileId!));
    }

    [Fact]
    public void Collections_Lifecycle_ShouldWork()
    {
        // Arrange
        var db = CreateDb();
        string rootId = db.GetOrCreateBaseRoot("/test");
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "f1.jpg", Hash = "h1" });
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "f2.jpg", Hash = "h2" });
        var f1 = db.GetFileId(rootId, "f1.jpg")!;
        var f2 = db.GetFileId(rootId, "f2.jpg")!;

        // Act: Create
        string colId = db.CreateCollection("My Trip");
        var collections = db.GetCollections().ToList();
        
        // Assert: Created
        Assert.Contains(collections, c => c.Name == "My Trip" && c.CollectionId == colId);

        // Act: Add Files
        db.AddFilesToCollection(colId, new[] { f1, f2 });
        var files = db.GetCollectionFiles(colId).ToList();

        // Assert: Files Added
        Assert.Equal(2, files.Count);
        Assert.Contains(f1, files);
        Assert.Contains(f2, files);

        // Act: Delete
        db.DeleteCollection(colId);
        collections = db.GetCollections().ToList();

        // Assert: Deleted
        Assert.DoesNotContain(collections, c => c.CollectionId == colId);
        Assert.Empty(db.GetCollectionFiles(colId));
    }

    [Fact]
    public void Metadata_Truncation_ShouldWork()
    {
        // Arrange
        var db = CreateDb();
        string rootId = db.GetOrCreateBaseRoot("/test");
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "meta.jpg" });
        var fileId = db.GetFileId(rootId, "meta.jpg")!;

        string longValue = new string('A', 200);

        // Act
        db.InsertMetadata(fileId, new[] { 
            new MetadataItem { Directory = "Custom", Tag = "LongTag", Value = longValue } 
        });

        // Assert
        var metadata = db.GetMetadata(fileId).ToList();
        var item = metadata.FirstOrDefault(m => m.Tag == "LongTag");
        Assert.NotNull(item);
        Assert.Equal(100, item.Value!.Length);
    }
}
