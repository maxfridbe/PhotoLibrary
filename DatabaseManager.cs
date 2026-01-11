using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Data.Sqlite;

namespace PhotoLibrary
{
    public class DatabaseManager
    {
        private readonly string _connectionString;

        public DatabaseManager(string dbPath)
        {
            _connectionString = $"Data Source={dbPath}";
        }

        public void Initialize()
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            string[] commands = new[] {
                @"CREATE TABLE IF NOT EXISTS RootPaths (
                    Id TEXT PRIMARY KEY,
                    ParentId TEXT,
                    Name TEXT,
                    FOREIGN KEY(ParentId) REFERENCES RootPaths(Id),
                    UNIQUE(ParentId, Name)
                );",
                @"CREATE TABLE IF NOT EXISTS FileEntry (
                    Id TEXT PRIMARY KEY,
                    RootPathId TEXT,
                    FileName TEXT,
                    Size INTEGER,
                    CreatedAt TEXT,
                    ModifiedAt TEXT,
                    FOREIGN KEY(RootPathId) REFERENCES RootPaths(Id),
                    UNIQUE(RootPathId, FileName)
                );",
                @"CREATE TABLE IF NOT EXISTS Metadata (
                    FileId TEXT,
                    Directory TEXT,
                    Tag TEXT,
                    Value TEXT,
                    FOREIGN KEY(FileId) REFERENCES FileEntry(Id)
                );",
                @"CREATE TABLE IF NOT EXISTS PickedImages (
                    FileId TEXT PRIMARY KEY,
                    PickedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(FileId) REFERENCES FileEntry(Id)
                );",
                @"CREATE TABLE IF NOT EXISTS ImageRatings (
                    FileId TEXT PRIMARY KEY,
                    Rating INTEGER,
                    FOREIGN KEY(FileId) REFERENCES FileEntry(Id)
                );",
                @"CREATE TABLE IF NOT EXISTS UserCollections (
                    Id TEXT PRIMARY KEY,
                    Name TEXT UNIQUE
                );",
                @"CREATE TABLE IF NOT EXISTS CollectionFiles (
                    CollectionId TEXT,
                    FileId TEXT,
                    PRIMARY KEY (CollectionId, FileId),
                    FOREIGN KEY(CollectionId) REFERENCES UserCollections(Id),
                    FOREIGN KEY(FileId) REFERENCES FileEntry(Id)
                );",
                @"CREATE INDEX IF NOT EXISTS IDX_Metadata_FileId ON Metadata(FileId);",
                @"CREATE INDEX IF NOT EXISTS IDX_FileEntry_CreatedAt ON FileEntry(CreatedAt);",
                @"CREATE INDEX IF NOT EXISTS IDX_FileEntry_RootPathId ON FileEntry(RootPathId);"
            };

            foreach (var cmdText in commands)
            {
                using var command = connection.CreateCommand();
                command.CommandText = cmdText;
                command.ExecuteNonQuery();
            }
        }

        public StatsResponse GetGlobalStats()
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var stats = new StatsResponse();
            var pickedCmd = connection.CreateCommand();
            pickedCmd.CommandText = "SELECT COUNT(*) FROM PickedImages";
            stats.PickedCount = Convert.ToInt32(pickedCmd.ExecuteScalar());
            var ratingCmd = connection.CreateCommand();
            ratingCmd.CommandText = "SELECT Rating, COUNT(*) FROM ImageRatings GROUP BY Rating";
            using var reader = ratingCmd.ExecuteReader();
            while (reader.Read()) {
                int r = reader.GetInt32(0);
                if (r >= 1 && r <= 5) stats.RatingCounts[r - 1] = reader.GetInt32(1);
            }
            return stats;
        }

        public PagedPhotosResponse GetPhotosPaged(int limit, int offset, string? rootId = null, bool pickedOnly = false, int rating = 0, string[]? specificIds = null)
        {
            var result = new PagedPhotosResponse();
            var entries = new List<PhotoResponse>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            
            var whereClauses = new List<string>();
            if (pickedOnly) whereClauses.Add("EXISTS (SELECT 1 FROM PickedImages p WHERE p.FileId = f.Id)");
            if (rating > 0) whereClauses.Add("EXISTS (SELECT 1 FROM ImageRatings r WHERE r.FileId = f.Id AND r.Rating = $Rating)");
            if (rootId != null) whereClauses.Add("f.RootPathId = $RootId");
            if (specificIds != null && specificIds.Length > 0) 
                whereClauses.Add($"f.Id IN ({string.Join(",", specificIds.Select(id => $"'{id}'"))})");

            string where = whereClauses.Count > 0 ? "WHERE " + string.Join(" AND ", whereClauses) : "";

            var command = connection.CreateCommand();
            command.CommandText = $@"
                SELECT f.Id, f.RootPathId, f.FileName, f.Size, f.CreatedAt, f.ModifiedAt, 
                       CASE WHEN (SELECT 1 FROM PickedImages p WHERE p.FileId = f.Id) IS NOT NULL THEN 1 ELSE 0 END as IsPicked,
                       COALESCE((SELECT r.Rating FROM ImageRatings r WHERE r.FileId = f.Id), 0) as Rating
                FROM FileEntry f
                {where}
                ORDER BY f.CreatedAt DESC 
                LIMIT $Limit OFFSET $Offset";

            command.Parameters.AddWithValue("$Limit", limit);
            command.Parameters.AddWithValue("$Offset", offset);
            if (rating > 0) command.Parameters.AddWithValue("$Rating", rating);
            if (rootId != null) command.Parameters.AddWithValue("$RootId", rootId);

            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                entries.Add(new PhotoResponse {
                    Id = reader.GetString(0),
                    RootPathId = reader.IsDBNull(1) ? null : reader.GetString(1),
                    FileName = reader.IsDBNull(2) ? null : reader.GetString(2),
                    Size = reader.GetInt64(3),
                    CreatedAt = DateTime.Parse(reader.GetString(4)),
                    ModifiedAt = DateTime.Parse(reader.GetString(5)),
                    IsPicked = reader.GetInt32(6) == 1,
                    Rating = reader.GetInt32(7)
                });
            }
            result.Photos = entries;
            
            var countCmd = connection.CreateCommand();
            countCmd.CommandText = $"SELECT COUNT(*) FROM FileEntry f {where}";
            if (rating > 0) countCmd.Parameters.AddWithValue("$Rating", rating);
            if (rootId != null) countCmd.Parameters.AddWithValue("$RootId", rootId);
            result.Total = Convert.ToInt32(countCmd.ExecuteScalar());

            return result;
        }

        // --- Collections ---
        public string CreateCollection(string name)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            string id = Guid.NewGuid().ToString();
            var command = connection.CreateCommand();
            command.CommandText = "INSERT INTO UserCollections (Id, Name) VALUES ($Id, $Name)";
            command.Parameters.AddWithValue("$Id", id);
            command.Parameters.AddWithValue("$Name", name);
            command.ExecuteNonQuery();
            return id;
        }

        public void DeleteCollection(string id)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();
            var cmd1 = connection.CreateCommand();
            cmd1.Transaction = transaction;
            cmd1.CommandText = "DELETE FROM CollectionFiles WHERE CollectionId = $Id";
            cmd1.Parameters.AddWithValue("$Id", id);
            cmd1.ExecuteNonQuery();
            var cmd2 = connection.CreateCommand();
            cmd2.Transaction = transaction;
            cmd2.CommandText = "DELETE FROM UserCollections WHERE Id = $Id";
            cmd2.Parameters.AddWithValue("$Id", id);
            cmd2.ExecuteNonQuery();
            transaction.Commit();
        }

        public void AddFilesToCollection(string collectionId, IEnumerable<string> fileIds)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();
            foreach (var fileId in fileIds) {
                var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = "INSERT OR IGNORE INTO CollectionFiles (CollectionId, FileId) VALUES ($CId, $FId)";
                command.Parameters.AddWithValue("$CId", collectionId);
                command.Parameters.AddWithValue("$FId", fileId);
                command.ExecuteNonQuery();
            }
            transaction.Commit();
        }

        public IEnumerable<CollectionResponse> GetCollections()
        {
            var list = new List<CollectionResponse>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            command.CommandText = @"
                SELECT c.Id, c.Name, COUNT(cf.FileId) 
                FROM UserCollections c 
                LEFT JOIN CollectionFiles cf ON c.Id = cf.CollectionId 
                GROUP BY c.Id, c.Name ORDER BY c.Name";
            using var reader = command.ExecuteReader();
            while (reader.Read()) list.Add(new CollectionResponse { Id = reader.GetString(0), Name = reader.GetString(1), Count = reader.GetInt32(2) });
            return list;
        }

        public IEnumerable<string> GetCollectionFiles(string collectionId)
        {
            var list = new List<string>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            command.CommandText = "SELECT FileId FROM CollectionFiles WHERE CollectionId = $Id";
            command.Parameters.AddWithValue("$Id", collectionId);
            using var reader = command.ExecuteReader();
            while (reader.Read()) list.Add(reader.GetString(0));
            return list;
        }

        public void ClearPicked()
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            command.CommandText = "DELETE FROM PickedImages";
            command.ExecuteNonQuery();
        }

        public IEnumerable<string> GetPickedIds()
        {
            var list = new List<string>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            command.CommandText = "SELECT FileId FROM PickedImages";
            using var reader = command.ExecuteReader();
            while (reader.Read()) list.Add(reader.GetString(0));
            return list;
        }

        // --- Directory Logic ---
        public string GetOrCreateBaseRoot(string absolutePath)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();
            string id = EnsureRootPathExists(connection, transaction, null, absolutePath);
            transaction.Commit();
            return id;
        }

        public string GetOrCreateChildRoot(string parentId, string name)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();
            string id = EnsureRootPathExists(connection, transaction, parentId, name);
            transaction.Commit();
            return id;
        }

        private string EnsureRootPathExists(SqliteConnection connection, SqliteTransaction transaction, string? parentId, string name)
        {
            var checkCmd = connection.CreateCommand();
            checkCmd.Transaction = transaction;
            if (parentId == null) checkCmd.CommandText = "SELECT Id FROM RootPaths WHERE ParentId IS NULL AND Name = $Name";
            else { checkCmd.CommandText = "SELECT Id FROM RootPaths WHERE ParentId = $ParentId AND Name = $Name"; checkCmd.Parameters.AddWithValue("$ParentId", parentId); }
            checkCmd.Parameters.AddWithValue("$Name", name);
            var existingId = checkCmd.ExecuteScalar() as string;
            if (existingId != null) return existingId;
            string newId = Guid.NewGuid().ToString();
            var insertCmd = connection.CreateCommand();
            insertCmd.Transaction = transaction;
            insertCmd.CommandText = "INSERT INTO RootPaths (Id, ParentId, Name) VALUES ($Id, $ParentId, $Name)";
            insertCmd.Parameters.AddWithValue("$Id", newId);
            insertCmd.Parameters.AddWithValue("$ParentId", (object?)parentId ?? DBNull.Value);
            insertCmd.Parameters.AddWithValue("$Name", name);
            insertCmd.ExecuteNonQuery();
            return newId;
        }

        public void UpsertFileEntry(FileEntry entry)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();
            var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = @"
                INSERT INTO FileEntry (Id, RootPathId, FileName, Size, CreatedAt, ModifiedAt)
                VALUES ($Id, $RootPathId, $FileName, $Size, $CreatedAt, $ModifiedAt)
                ON CONFLICT(RootPathId, FileName) DO UPDATE SET Size = excluded.Size, CreatedAt = excluded.CreatedAt, ModifiedAt = excluded.ModifiedAt;
            ";
            command.Parameters.AddWithValue("$Id", entry.Id);
            command.Parameters.AddWithValue("$RootPathId", entry.RootPathId ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$FileName", entry.FileName ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$Size", entry.Size);
            command.Parameters.AddWithValue("$CreatedAt", entry.CreatedAt.ToString("o"));
            command.Parameters.AddWithValue("$ModifiedAt", entry.ModifiedAt.ToString("o"));
            command.ExecuteNonQuery();
            
            var getIdCmd = connection.CreateCommand();
            getIdCmd.Transaction = transaction;
            getIdCmd.CommandText = "SELECT Id FROM FileEntry WHERE RootPathId = $RootPathId AND FileName = $FileName";
            getIdCmd.Parameters.AddWithValue("$RootPathId", entry.RootPathId ?? (object)DBNull.Value);
            getIdCmd.Parameters.AddWithValue("$FileName", entry.FileName ?? (object)DBNull.Value);
            var actualId = getIdCmd.ExecuteScalar() as string;
            if (actualId != null) {
                var deleteCmd = connection.CreateCommand();
                deleteCmd.Transaction = transaction;
                deleteCmd.CommandText = "DELETE FROM Metadata WHERE FileId = $FileId";
                deleteCmd.Parameters.AddWithValue("$FileId", actualId);
                deleteCmd.ExecuteNonQuery();
            }
            transaction.Commit();
        }

        public string? GetFileId(string rootPathId, string fileName)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            command.CommandText = "SELECT Id FROM FileEntry WHERE RootPathId = $RootPathId AND FileName = $FileName";
            command.Parameters.AddWithValue("$RootPathId", rootPathId);
            command.Parameters.AddWithValue("$FileName", fileName);
            return command.ExecuteScalar() as string;
        }

        public void InsertMetadata(string fileId, IEnumerable<MetadataItem> items)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();
            foreach (var item in items) {
                var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = @"INSERT INTO Metadata (FileId, Directory, Tag, Value) VALUES ($FileId, $Directory, $Tag, $Value)";
                command.Parameters.AddWithValue("$FileId", fileId);
                command.Parameters.AddWithValue("$Directory", item.Directory ?? "");
                command.Parameters.AddWithValue("$Tag", item.Tag ?? "");
                command.Parameters.AddWithValue("$Value", item.Value ?? "");
                command.ExecuteNonQuery();
            }
            transaction.Commit();
        }

        public IEnumerable<RootPathResponse> GetAllRootPaths()
        {
            var items = new List<RootPathResponse>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            command.CommandText = "SELECT Id, ParentId, Name FROM RootPaths";
            using var reader = command.ExecuteReader();
            while (reader.Read()) items.Add(new RootPathResponse { Id = reader.GetString(0), ParentId = reader.IsDBNull(1) ? null : reader.GetString(1), Name = reader.GetString(2) });
            return items;
        }

        public IEnumerable<MetadataItemResponse> GetMetadata(string fileId)
        {
            var items = new List<MetadataItemResponse>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            command.CommandText = "SELECT Directory, Tag, Value FROM Metadata WHERE FileId = $FileId";
            command.Parameters.AddWithValue("$FileId", fileId);
            using var reader = command.ExecuteReader();
            while (reader.Read()) items.Add(new MetadataItemResponse { Directory = reader.IsDBNull(0) ? null : reader.GetString(0), Tag = reader.IsDBNull(1) ? null : reader.GetString(1), Value = reader.IsDBNull(2) ? null : reader.GetString(2) });
            return items;
        }

        public void SetPicked(string fileId, bool isPicked)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            if (isPicked) command.CommandText = "INSERT OR IGNORE INTO PickedImages (FileId) VALUES ($Id)";
            else command.CommandText = "DELETE FROM PickedImages WHERE FileId = $Id";
            command.Parameters.AddWithValue("$Id", fileId);
            command.ExecuteNonQuery();
        }

        public void SetRating(string fileId, int rating)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            if (rating > 0) {
                command.CommandText = @"INSERT INTO ImageRatings (FileId, Rating) VALUES ($Id, $Rating) ON CONFLICT(FileId) DO UPDATE SET Rating = excluded.Rating";
                command.Parameters.AddWithValue("$Rating", rating);
            } else command.CommandText = "DELETE FROM ImageRatings WHERE FileId = $Id";
            command.Parameters.AddWithValue("$Id", fileId);
            command.ExecuteNonQuery();
        }

        public IEnumerable<string> SearchMetadata(string tag, string value)
        {
            var ids = new List<string>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            command.CommandText = "SELECT DISTINCT FileId FROM Metadata WHERE Tag = $Tag AND Value = $Value";
            command.Parameters.AddWithValue("$Tag", tag);
            command.Parameters.AddWithValue("$Value", value);
            using var reader = command.ExecuteReader();
            while (reader.Read()) ids.Add(reader.GetString(0));
            return ids;
        }
    }
}