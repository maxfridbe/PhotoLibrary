using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Extensions.Logging;
using Xunit;
using Microsoft.Data.Sqlite;

namespace PhotoLibrary.Backend.Tests;

public class DatabaseCompleteTests : TestBase
{
    private DatabaseManager CreateDb()
    {
        var db = new DatabaseManager(DbPath, LoggerFactory.CreateLogger<DatabaseManager>());
        db.Initialize();
        return db;
    }

    [Fact]
    public void Settings_Lifecycle_ShouldWork()
    {
        var db = CreateDb();
        
        // Act: Set
        db.SetSetting("theme", "dark-pro");
        db.SetSetting("zoom-level", "1.5");
        
        // Assert: Get
        Assert.Equal("dark-pro", db.GetSetting("theme"));
        Assert.Equal("1.5", db.GetSetting("zoom-level"));
        Assert.Null(db.GetSetting("non-existent"));
        
        // Act: Update
        db.SetSetting("theme", "light");
        Assert.Equal("light", db.GetSetting("theme"));
    }

    [Fact]
    public void PickedAndRating_ShouldPersist()
    {
        var db = CreateDb();
        string rootId = db.GetOrCreateBaseRoot("/test");
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "cull.jpg" });
        var fileId = db.GetFileId(rootId, "cull.jpg")!;

        // Act: Pick
        db.SetPicked(fileId, true);
        db.SetRating(fileId, 5);

        // Assert
        var picked = db.GetPickedIds().ToList();
        Assert.Contains(fileId, picked);
        
        var stats = db.GetGlobalStats();
        Assert.Equal(1, stats.PickedCount);
        Assert.Equal(1, stats.RatingCounts[4]); // Index 4 is 5 stars

        // Act: Unpick
        db.SetPicked(fileId, false);
        Assert.Empty(db.GetPickedIds());
        
        // Act: Clear all
        db.SetPicked(fileId, true);
        db.ClearPicked();
        Assert.Empty(db.GetPickedIds());
    }

    [Fact]
    public void LibraryInfo_ShouldReflectCurrentState()
    {
        var db = CreateDb();
        string rootId = db.GetOrCreateBaseRoot("/test");
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "info1.jpg", Hash = "h1" });
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "info2.jpg", Hash = "h2" });

        // Act
        var info = db.GetLibraryInfo("mock_previews.db", "mock_config.json");

        // Assert
        Assert.Equal(2, info.TotalImages);
        Assert.Equal(DbPath, info.DbPath);
        Assert.Equal("mock_previews.db", info.PreviewDbPath);
    }

    [Fact]
    public void FileExistence_ByHashAndPath_ShouldWork()
    {
        var db = CreateDb();
        string rootPath = _pm.Normalize(Path.Combine(TestTempDir, "existence"));
        Directory.CreateDirectory(rootPath);
        string fullPath = Path.Combine(rootPath, "photo.jpg");
        File.WriteAllText(fullPath, "dummy");
        
        string rootId = db.GetOrCreateBaseRoot(rootPath);
        db.UpsertFileEntry(new FileEntry { 
            RootPathId = rootId, 
            FileName = "photo.jpg", 
            Hash = "unique_hash_123",
            ModifiedAt = File.GetLastWriteTime(fullPath)
        });

        // Assert: By Hash
        Assert.True(db.FileExistsByHash("unique_hash_123"));
        Assert.False(db.FileExistsByHash("missing_hash"));

        // Assert: By Path
        Assert.True(db.FileExists(fullPath));
        var (exists, lastMod) = db.GetExistingFileStatus(fullPath);
        Assert.True(exists);
        Assert.NotNull(lastMod);

        // Assert: GetFileIdByPath
        Assert.Equal(db.GetFileId(rootId, "photo.jpg"), db.GetFileIdByPath(fullPath));
    }

    [Fact]
    public void Paging_ShouldReturnCorrectSubsets()
    {
        var db = CreateDb();
        string rootId = db.GetOrCreateBaseRoot("/test");
        for (int i = 1; i <= 10; i++)
        {
            db.UpsertFileEntry(new FileEntry { 
                RootPathId = rootId, 
                FileName = $"img{i:D2}.jpg",
                CreatedAt = DateTime.Now.AddMinutes(i) // Ensure deterministic order
            });
        }

        // Act: Get first page
        var page1 = db.GetPhotosPaged(4, 0);
        // Act: Get second page
        var page2 = db.GetPhotosPaged(4, 4);

        // Assert
        Assert.Equal(10, page1.Total);
        Assert.Equal(4, page1.Photos.Count());
        Assert.Equal(4, page2.Photos.Count());
        // Ensure no overlap (order by CreatedAt DESC)
        Assert.Empty(page1.Photos.Select(p => p.FileEntryId).Intersect(page2.Photos.Select(p => p.FileEntryId)));
    }

    [Fact]
    public void GeotaggedPhotos_ShouldBeIndexed()
    {
        var db = CreateDb();
        string rootId = db.GetOrCreateBaseRoot("/gps");
        db.UpsertFileEntry(new FileEntry { RootPathId = rootId, FileName = "gps.jpg" });
        var fileId = db.GetFileId(rootId, "gps.jpg")!;

        // Act: Add GPS Metadata
        db.InsertMetadata(fileId, new[] {
            new MetadataItem { Directory = "GPS", Tag = "GPS Latitude", Value = "59° 20' 0\"" },
            new MetadataItem { Directory = "GPS", Tag = "GPS Latitude Ref", Value = "N" },
            new MetadataItem { Directory = "GPS", Tag = "GPS Longitude", Value = "18° 3' 0\"" },
            new MetadataItem { Directory = "GPS", Tag = "GPS Longitude Ref", Value = "E" }
        });

        // Assert
        var geotagged = db.GetGeotaggedPhotosPaged(10, 0);
        Assert.Equal(1, geotagged.Total);
        
        var mapPhotos = db.GetMapPhotos();
        Assert.Equal(1, mapPhotos.Total);
        var first = mapPhotos.Photos.First();
        Assert.Equal(59.333, first.Latitude, 3);
        Assert.Equal(18.05, first.Longitude, 3);
    }

    [Fact]
    public void DirectoryAnalysis_ShouldResolveAbsolutePaths()
    {
        var db = CreateDb();
        string baseDir = _pm.Normalize(Path.Combine(TestTempDir, "analysis"));
        string subDir = Path.Combine(baseDir, "2024");
        Directory.CreateDirectory(subDir);
        
        string baseId = db.GetOrCreateBaseRoot(baseDir);
        string subId = db.GetOrCreateChildRoot(baseId, "2024");
        
        db.UpsertFileEntry(new FileEntry { RootPathId = subId, FileName = "test.jpg" });

        // Assert: GetAllFilePathsForRoot
        var paths = db.GetAllFilePathsForRoot(baseId);
        Assert.Contains(_pm.Normalize(Path.Combine(subDir, "test.jpg")), paths);

        // Assert: GetAllIndexedDirectories
        var dirs = db.GetAllIndexedDirectories();
        Assert.Contains(baseDir, dirs);
        Assert.Contains(subDir, dirs);

        // Assert: FindClosestRoot
        Assert.Equal(subId, db.FindClosestRoot(Path.Combine(subDir, "anything.jpg")));
        Assert.Equal(baseId, db.FindClosestRoot(Path.Combine(baseDir, "root_file.jpg")));
    }

    [Fact]
    public void FolderAnnotation_ShouldPersist()
    {
        var db = CreateDb();
        string rootId = db.GetOrCreateBaseRoot("/test");
        
        // Act
        db.SetFolderAnnotation(rootId, "Favorite Summer", "#FF5733");
        
        // Assert
        var tree = db.GetDirectoryTree().ToList();
        var node = tree.First(n => n.DirectoryId == rootId);
        Assert.Equal("Favorite Summer", node.Annotation);
        Assert.Equal("#FF5733", node.Color);
    }

    [Fact]
    public void SpecializedQueries_ShouldReturnCorrectData()
    {
        var db = CreateDb();
        string rootA = db.GetOrCreateBaseRoot("/rootA");
        string rootB = db.GetOrCreateChildRoot(rootA, "subB");
        
        db.UpsertFileEntry(new FileEntry { RootPathId = rootA, FileName = "fileA.jpg", Hash = "hA" });
        db.UpsertFileEntry(new FileEntry { RootPathId = rootB, FileName = "fileB.jpg", Hash = "hB" });
        var idA = db.GetFileId(rootA, "fileA.jpg")!;
        var idB = db.GetFileId(rootB, "fileB.jpg")!;

        // 1. LocateFile
        var located = (List<object>)db.LocateFile("fileA.jpg")!;
        Assert.Single(located);

        // 2. DebugFolder
        var debug = db.DebugFolder(rootA);
        Assert.NotNull(debug);

        // 3. GetFileIdsUnderRoot (Recursive vs Non-Recursive)
        var nonRec = db.GetFileIdsUnderRoot(rootA, false);
        Assert.Single(nonRec);
        Assert.Contains(idA, nonRec);

        var rec = db.GetFileIdsUnderRoot(rootA, true);
        Assert.Equal(2, rec.Count);
        Assert.Contains(idA, rec);
        Assert.Contains(idB, rec);

        // 4. GetFileHashesUnderRoot
        var hashes = db.GetFileHashesUnderRoot(rootA);
        Assert.Equal(2, hashes.Count);
        Assert.Contains("hA", hashes);
        Assert.Contains("hB", hashes);

        // 5. GetExistingFileNames
        var existing = db.GetExistingFileNames(rootA, new[] { "fileA.jpg", "missing.jpg" });
        Assert.Single(existing);
        Assert.Contains("fileA.jpg", existing);

        // 6. DeleteFileEntry
        using (var conn = db.GetOpenConnection())
        {
            db.DeleteFileEntryWithConnection(conn, null, idA);
        }
        Assert.Null(db.GetFileId(rootA, "fileA.jpg"));
    }

    private readonly PathManager _pm = new();
}
