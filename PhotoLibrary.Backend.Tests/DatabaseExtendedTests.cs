using System;
using System.IO;
using System.Linq;
using Microsoft.Extensions.Logging;
using Xunit;
using Microsoft.Data.Sqlite;

namespace PhotoLibrary.Backend.Tests;

public class DatabaseExtendedTests : TestBase
{
    private DatabaseManager CreateDb()
    {
        var db = new DatabaseManager(DbPath, LoggerFactory.CreateLogger<DatabaseManager>());
        db.Initialize();
        return db;
    }

    [Fact]
    public void RecordTouched_ShouldUseTimestamp()
    {
        // Arrange
        var db = CreateDb();
        string rootId = db.GetOrCreateBaseRoot("/test");
        var entry = new FileEntry { 
            RootPathId = rootId, 
            FileName = "touch_test.jpg", 
            CreatedAt = DateTime.Now,
            ModifiedAt = DateTime.Now 
        };
        
        // Act: Insert
        db.UpsertFileEntry(entry);
        var fileId = db.GetFileId(rootId, "touch_test.jpg")!;
        
        // Assert: Initial timestamp set
        long initialTimestamp = GetRecordTouched(db, fileId);
        Assert.True(initialTimestamp > 0);
        
        // Act: Manual Touch
        long newTimestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 100;
        using (var conn = db.GetOpenConnection())
        {
            db.TouchFile(conn, null, fileId, newTimestamp);
        }
        
        // Assert: Timestamp updated
        Assert.Equal(newTimestamp, GetRecordTouched(db, fileId));
    }

    [Fact]
    public void UpsertFileEntry_ShouldSetInitialTimestamp()
    {
        // Arrange
        var db = CreateDb();
        string rootId = db.GetOrCreateBaseRoot("/test");
        var entry = new FileEntry { RootPathId = rootId, FileName = "init_touch.jpg" };
        
        // Act
        db.UpsertFileEntry(entry);
        var fileId = db.GetFileId(rootId, "init_touch.jpg")!;
        
        // Assert
        long timestamp = GetRecordTouched(db, fileId);
        Assert.True(timestamp > 0);
        // Should be roughly current time
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        Assert.True(Math.Abs(now - timestamp) < 5);
    }

    [Fact]
    public void TouchFileWithRoot_ShouldUpdateBoth()
    {
        // Arrange
        var db = CreateDb();
        string rootA = db.GetOrCreateBaseRoot("/rootA");
        string rootB = db.GetOrCreateBaseRoot("/rootB");
        var entry = new FileEntry { RootPathId = rootA, FileName = "move_test.jpg" };
        db.UpsertFileEntry(entry);
        var fileId = db.GetFileId(rootA, "move_test.jpg")!;
        
        // Act
        long timestamp = 1234567890;
        using (var conn = db.GetOpenConnection())
        {
            db.TouchFileWithRoot(conn, null, fileId, rootB, timestamp);
        }
        
        // Assert
        Assert.Equal(timestamp, GetRecordTouched(db, fileId));
        Assert.Equal(rootB, db.GetFileRootId(fileId));
    }

    [Fact]
    public void GetOrCreateHierarchy_ShouldCreateIntermediateRoots()
    {
        // Arrange
        var db = CreateDb();
        string baseRootPath = _pm.Normalize(Path.Combine(TestTempDir, "base"));
        string targetPath = _pm.Normalize(Path.Combine(baseRootPath, "2024", "Vacation", "Day1"));
        
        string baseId = db.GetOrCreateBaseRoot(baseRootPath);
        
        // Act
        string finalId;
        using (var conn = db.GetOpenConnection())
        using (var trans = conn.BeginTransaction())
        {
            finalId = db.GetOrCreateHierarchy(conn, trans, baseId, baseRootPath, targetPath);
            trans.Commit();
        }
        
        // Assert
        Assert.NotNull(finalId);
        var tree = db.GetDirectoryTree().ToList();
        var baseNode = tree.First(r => r.DirectoryId == baseId);
        
        // Structure should be: base -> 2024 -> Vacation -> Day1
        var node2024 = baseNode.Children.First(c => c.Name == "2024");
        var nodeVacation = node2024.Children.First(c => c.Name == "Vacation");
        var nodeDay1 = nodeVacation.Children.First(c => c.Name == "Day1");
        
        Assert.Equal(finalId, nodeDay1.DirectoryId);
    }

    [Fact]
    public void DeduplicateRoots_ShouldMergeOverlappingPaths()
    {
        // Arrange
        var db = CreateDb();
        // Create two roots that point to same logical path (simulating old bugs or symlink overlaps)
        // Note: GetOrCreateBaseRoot normalizes, so we have to manually insert a "bad" record if we want to test dedupe
        // Or we use different symlink paths that resolve to same physical path.
        
        string realPath = Path.Combine(TestTempDir, "real");
        Directory.CreateDirectory(realPath);
        
        // Root 1
        string id1 = db.GetOrCreateBaseRoot(realPath);
        db.UpsertFileEntry(new FileEntry { RootPathId = id1, FileName = "photo1.jpg" });
        
        // Manually inject a "duplicate" root with same path but different ID
        string id2 = Guid.NewGuid().ToString();
        using (var conn = db.GetOpenConnection())
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "INSERT INTO RootPaths (Id, Name) VALUES ($Id, $Name)";
            cmd.Parameters.AddWithValue("$Id", id2);
            cmd.Parameters.AddWithValue("$Name", realPath);
            cmd.ExecuteNonQuery();
        }
        db.UpsertFileEntry(new FileEntry { RootPathId = id2, FileName = "photo2.jpg" });
        
        // Verify we have 2 roots initially
        Assert.Equal(2, db.GetDirectoryTree().Count());

        // Act
        int merged = db.DeduplicateRoots();

        // Assert
        Assert.Equal(1, merged);
        var tree = db.GetDirectoryTree().ToList();
        Assert.Single(tree);
        
        // Verify files were moved to the winner
        string winnerId = tree[0].DirectoryId;
        var files = db.GetFileIdsUnderRoot(winnerId, false);
        Assert.Equal(2, files.Count);
    }

    private long GetRecordTouched(DatabaseManager db, string fileId)
    {
        using var conn = db.GetOpenConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT RecordTouched FROM FileEntry WHERE Id = $Id";
        cmd.Parameters.AddWithValue("$Id", fileId);
        return Convert.ToInt64(cmd.ExecuteScalar());
    }

    private readonly PathManager _pm = new();
}
