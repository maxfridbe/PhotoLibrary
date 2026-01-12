using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Data.Sqlite;
using static PhotoLibrary.TableConstants;

namespace PhotoLibrary
{
    public class DatabaseManager
    {
        private readonly string _connectionString;
        public string DbPath { get; }

        public DatabaseManager(string dbPath)
        {
            DbPath = dbPath;
            _connectionString = $"Data Source={dbPath}";
        }

        public void Initialize()
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            using (var command = connection.CreateCommand())
            {
                command.CommandText = "PRAGMA journal_mode=WAL;";
                command.ExecuteNonQuery();
            }

            string[] schema = new[] {
                $@"CREATE TABLE IF NOT EXISTS {TableName.RootPaths} (
                    {Column.RootPaths.Id} TEXT PRIMARY KEY,
                    {Column.RootPaths.ParentId} TEXT,
                    {Column.RootPaths.Name} TEXT,
                    FOREIGN KEY({Column.RootPaths.ParentId}) REFERENCES {TableName.RootPaths}({Column.RootPaths.Id}),
                    UNIQUE({Column.RootPaths.ParentId}, {Column.RootPaths.Name})
                );",
                $@"CREATE TABLE IF NOT EXISTS {TableName.FileEntry} (
                    {Column.FileEntry.Id} TEXT PRIMARY KEY,
                    {Column.FileEntry.RootPathId} TEXT,
                    {Column.FileEntry.FileName} TEXT,
                    {Column.FileEntry.BaseName} TEXT,
                    {Column.FileEntry.Size} INTEGER,
                    {Column.FileEntry.CreatedAt} TEXT,
                    {Column.FileEntry.ModifiedAt} TEXT,
                    FOREIGN KEY({Column.FileEntry.RootPathId}) REFERENCES {TableName.RootPaths}({Column.RootPaths.Id}),
                    UNIQUE({Column.FileEntry.RootPathId}, {Column.FileEntry.FileName})
                );",
                $@"CREATE TABLE IF NOT EXISTS {TableName.Metadata} (
                    {Column.Metadata.FileId} TEXT,
                    {Column.Metadata.Directory} TEXT,
                    {Column.Metadata.Tag} TEXT,
                    {Column.Metadata.Value} TEXT,
                    FOREIGN KEY({Column.Metadata.FileId}) REFERENCES {TableName.FileEntry}({Column.FileEntry.Id})
                );",
                $@"CREATE TABLE IF NOT EXISTS {TableName.ImagesPicked} (
                    {Column.ImagesPicked.FileId} TEXT PRIMARY KEY,
                    {Column.ImagesPicked.PickedAt} TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY({Column.ImagesPicked.FileId}) REFERENCES {TableName.FileEntry}({Column.FileEntry.Id})
                );",
                $@"CREATE TABLE IF NOT EXISTS {TableName.ImageRatings} (
                    {Column.ImageRatings.FileId} TEXT PRIMARY KEY,
                    {Column.ImageRatings.Rating} INTEGER,
                    FOREIGN KEY({Column.ImageRatings.FileId}) REFERENCES {TableName.FileEntry}({Column.FileEntry.Id})
                );",
                $@"CREATE TABLE IF NOT EXISTS {TableName.UserCollections} (
                    {Column.UserCollections.Id} TEXT PRIMARY KEY,
                    {Column.UserCollections.Name} TEXT UNIQUE
                );",
                $@"CREATE TABLE IF NOT EXISTS {TableName.CollectionFiles} (
                    {Column.CollectionFiles.CollectionId} TEXT,
                    {Column.CollectionFiles.FileId} TEXT,
                    PRIMARY KEY ({Column.CollectionFiles.CollectionId}, {Column.CollectionFiles.FileId}),
                    FOREIGN KEY({Column.CollectionFiles.CollectionId}) REFERENCES {TableName.UserCollections}({Column.UserCollections.Id}),
                    FOREIGN KEY({Column.CollectionFiles.FileId}) REFERENCES {TableName.FileEntry}({Column.FileEntry.Id})
                );",
                @"CREATE TABLE IF NOT EXISTS Settings (
                    Key TEXT PRIMARY KEY,
                    Value TEXT
                );",
                $@"CREATE INDEX IF NOT EXISTS IDX_Metadata_FileId ON {TableName.Metadata}({Column.Metadata.FileId});",
                $@"CREATE INDEX IF NOT EXISTS IDX_FileEntry_CreatedAt ON {TableName.FileEntry}({Column.FileEntry.CreatedAt});",
                $@"CREATE INDEX IF NOT EXISTS IDX_FileEntry_RootPathId ON {TableName.FileEntry}({Column.FileEntry.RootPathId});"
            };

            foreach (var sql in schema)
            {
                using (var command = connection.CreateCommand())
                {
                    command.CommandText = sql;
                    command.ExecuteNonQuery();
                }
            }

            // Ensure BaseName column exists (Migration for older databases)
            try
            {
                using (var command = connection.CreateCommand())
                {
                    command.CommandText = $"ALTER TABLE {TableName.FileEntry} ADD COLUMN {Column.FileEntry.BaseName} TEXT;";
                    command.ExecuteNonQuery();
                }
            }
            catch (SqliteException ex) when (ex.SqliteErrorCode == 1) { /* Already exists */ }

            NormalizeRootPaths(connection);
        }

        private void NormalizeRootPaths(SqliteConnection connection)
        {
            var baseRoots = new List<(string id, string path)>();
            using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText = $"SELECT {Column.RootPaths.Id}, {Column.RootPaths.Name} FROM {TableName.RootPaths} WHERE {Column.RootPaths.ParentId} IS NULL";
                using var reader = cmd.ExecuteReader();
                while (reader.Read()) 
                {
                    var path = reader.GetString(1);
                    if (!string.IsNullOrWhiteSpace(path)) baseRoots.Add((reader.GetString(0), path));
                }
            }

            if (baseRoots.Count < 2) return;

            // Sort by path length so parents come first
            baseRoots = baseRoots.OrderBy(r => r.path.Length).ToList();

            using var transaction = connection.BeginTransaction();
            try 
            {
                for (int i = 0; i < baseRoots.Count; i++)
                {
                    for (int j = i + 1; j < baseRoots.Count; j++)
                    {
                        var parent = baseRoots[i];
                        var child = baseRoots[j];

                        if (child.path.StartsWith(parent.path + Path.DirectorySeparatorChar) || child.path.StartsWith(parent.path + "/"))
                        {
                            // child is actually inside parent.
                            string relative = Path.GetRelativePath(parent.path, child.path);
                            string[] parts = relative.Split(new[] { Path.DirectorySeparatorChar, '/' }, StringSplitOptions.RemoveEmptyEntries);
                            
                            // Stitch child to parent
                            string currentParentId = parent.id;
                            for (int p = 0; p < parts.Length - 1; p++)
                            {
                                currentParentId = EnsureRootPathExists(connection, transaction, currentParentId, parts[p]);
                            }

                            // Finally, move the child base root under currentParentId
                            // Safety: Cannot be its own parent
                            if (currentParentId == child.id) continue;

                            using (var updateCmd = connection.CreateCommand())
                            {
                                updateCmd.Transaction = transaction;
                                updateCmd.CommandText = $"UPDATE {TableName.RootPaths} SET {Column.RootPaths.ParentId} = $ParentId, {Column.RootPaths.Name} = $Name WHERE {Column.RootPaths.Id} = $Id";
                                updateCmd.Parameters.AddWithValue("$ParentId", currentParentId);
                                updateCmd.Parameters.AddWithValue("$Name", parts.Last());
                                updateCmd.Parameters.AddWithValue("$Id", child.id);
                                updateCmd.ExecuteNonQuery();
                            }
                        }
                    }
                }
                transaction.Commit();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[DB] Root normalization failed: {ex.Message}");
                transaction.Rollback();
            }
        }

        public string? GetSetting(string key)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT Value FROM Settings WHERE Key = $Key";
                command.Parameters.AddWithValue("$Key", key);
                return command.ExecuteScalar() as string;
            }
        }

        public void SetSetting(string key, string value)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "INSERT INTO Settings (Key, Value) VALUES ($Key, $Value) ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value";
                command.Parameters.AddWithValue("$Key", key);
                command.Parameters.AddWithValue("$Value", value);
                command.ExecuteNonQuery();
            }
        }

        public LibraryInfoResponse GetLibraryInfo(string previewDbPath)
        {
            var info = new LibraryInfoResponse();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            // Total Images
            using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText = $"SELECT COUNT(*) FROM {TableName.FileEntry}";
                info.TotalImages = Convert.ToInt32(cmd.ExecuteScalar());
            }

            // DB Sizes
            info.DbPath = connection.DataSource;
            info.DbSize = new FileInfo(connection.DataSource).Length;
            if (File.Exists(previewDbPath))
            {
                info.PreviewDbSize = new FileInfo(previewDbPath).Length;
            }

            // Folders
            using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText = $@"
                    SELECT r.{Column.RootPaths.Id}, r.{Column.RootPaths.Name}, r.{Column.RootPaths.ParentId},
                           (SELECT COUNT(*) FROM {TableName.FileEntry} f WHERE f.{Column.FileEntry.RootPathId} = r.{Column.RootPaths.Id}) as Count
                    FROM {TableName.RootPaths} r
                    ORDER BY r.{Column.RootPaths.Name}";
                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    info.Folders.Add(new LibraryFolderResponse
                    {
                        Id = reader.GetString(0),
                        Path = reader.GetString(1),
                        ParentId = reader.IsDBNull(2) ? null : reader.GetString(2),
                        ImageCount = reader.GetInt32(3)
                    });
                }
            }

            return info;
        }

        public StatsResponse GetGlobalStats()
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var stats = new StatsResponse();
            
            using (var totalCmd = connection.CreateCommand())
            {
                totalCmd.CommandText = $"SELECT COUNT(*) FROM {TableName.FileEntry}";
                stats.TotalCount = Convert.ToInt32(totalCmd.ExecuteScalar());
            }

            using (var pickedCmd = connection.CreateCommand())
            {
                pickedCmd.CommandText = $"SELECT COUNT(*) FROM {TableName.ImagesPicked}";
                stats.PickedCount = Convert.ToInt32(pickedCmd.ExecuteScalar());
            }
            
            using (var ratingCmd = connection.CreateCommand())
            {
                ratingCmd.CommandText = $"SELECT {Column.ImageRatings.Rating}, COUNT(*) FROM {TableName.ImageRatings} GROUP BY {Column.ImageRatings.Rating}";
                using var reader = ratingCmd.ExecuteReader();
                while (reader.Read()) {
                    int r = reader.GetInt32(0);
                    if (r >= 1 && r <= 5) stats.RatingCounts[r - 1] = reader.GetInt32(1);
                }
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
            if (pickedOnly) whereClauses.Add($"EXISTS (SELECT 1 FROM {TableName.ImagesPicked} p WHERE p.{Column.ImagesPicked.FileId} = f.{Column.FileEntry.Id})");
            if (rating > 0) whereClauses.Add($"EXISTS (SELECT 1 FROM {TableName.ImageRatings} r WHERE r.{Column.ImageRatings.FileId} = f.{Column.FileEntry.Id} AND r.{Column.ImageRatings.Rating} = $Rating)");
            if (rootId != null) whereClauses.Add($"f.{Column.FileEntry.RootPathId} = $RootId");
            if (specificIds != null && specificIds.Length > 0) 
                whereClauses.Add($"f.{Column.FileEntry.Id} IN ({string.Join(",", specificIds.Select(id => $"'{id}'"))})");

            string where = whereClauses.Count > 0 ? "WHERE " + string.Join(" AND ", whereClauses) : "";

            using (var command = connection.CreateCommand())
            {
                command.CommandText = $@"
                    SELECT f.{Column.FileEntry.Id}, f.{Column.FileEntry.RootPathId}, f.{Column.FileEntry.FileName}, f.{Column.FileEntry.Size}, f.{Column.FileEntry.CreatedAt}, f.{Column.FileEntry.ModifiedAt}, 
                           CASE WHEN (SELECT 1 FROM {TableName.ImagesPicked} p WHERE p.{Column.ImagesPicked.FileId} = f.{Column.FileEntry.Id}) IS NOT NULL THEN 1 ELSE 0 END as IsPicked,
                           COALESCE((SELECT r.{Column.ImageRatings.Rating} FROM {TableName.ImageRatings} r WHERE r.{Column.ImageRatings.FileId} = f.{Column.FileEntry.Id}), 0) as Rating
                    FROM {TableName.FileEntry} f
                    {where}
                    ORDER BY f.{Column.FileEntry.CreatedAt} DESC 
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
                        Rating = reader.GetInt32(7),
                        StackCount = 1
                    });
                }
            }
            result.Photos = entries;
            
            using (var countCmd = connection.CreateCommand())
            {
                countCmd.CommandText = $"SELECT COUNT(*) FROM {TableName.FileEntry} f {where}";
                if (rating > 0) countCmd.Parameters.AddWithValue("$Rating", rating);
                if (rootId != null) countCmd.Parameters.AddWithValue("$RootId", rootId);
                result.Total = Convert.ToInt32(countCmd.ExecuteScalar());
            }

            return result;
        }

        // --- Collections ---
        public string CreateCollection(string name)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            string id = Guid.NewGuid().ToString();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"INSERT INTO {TableName.UserCollections} ({Column.UserCollections.Id}, {Column.UserCollections.Name}) VALUES ($Id, $Name)";
                command.Parameters.AddWithValue("$Id", id);
                command.Parameters.AddWithValue("$Name", name);
                command.ExecuteNonQuery();
            }
            return id;
        }

        public void DeleteCollection(string id)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();
            using (var cmd1 = connection.CreateCommand())
            {
                cmd1.Transaction = transaction;
                cmd1.CommandText = $"DELETE FROM {TableName.CollectionFiles} WHERE {Column.CollectionFiles.CollectionId} = $Id";
                cmd1.Parameters.AddWithValue("$Id", id);
                cmd1.ExecuteNonQuery();
            }
            using (var cmd2 = connection.CreateCommand())
            {
                cmd2.Transaction = transaction;
                cmd2.CommandText = $"DELETE FROM {TableName.UserCollections} WHERE {Column.UserCollections.Id} = $Id";
                cmd2.Parameters.AddWithValue("$Id", id);
                cmd2.ExecuteNonQuery();
            }
            transaction.Commit();
        }

        public void AddFilesToCollection(string collectionId, IEnumerable<string> fileIds)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();
            foreach (var fileId in fileIds) {
                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = $"INSERT OR IGNORE INTO {TableName.CollectionFiles} ({Column.CollectionFiles.CollectionId}, {Column.CollectionFiles.FileId}) VALUES ($CId, $FId)";
                    command.Parameters.AddWithValue("$CId", collectionId);
                    command.Parameters.AddWithValue("$FId", fileId);
                    command.ExecuteNonQuery();
                }
            }
            transaction.Commit();
        }

        public IEnumerable<CollectionResponse> GetCollections()
        {
            var list = new List<CollectionResponse>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = $@"
                    SELECT c.{Column.UserCollections.Id}, c.{Column.UserCollections.Name}, COUNT(cf.{Column.CollectionFiles.FileId}) 
                    FROM {TableName.UserCollections} c 
                    LEFT JOIN {TableName.CollectionFiles} cf ON c.{Column.UserCollections.Id} = cf.{Column.CollectionFiles.CollectionId} 
                    GROUP BY c.{Column.UserCollections.Id}, c.{Column.UserCollections.Name} ORDER BY c.{Column.UserCollections.Name}";
                using var reader = command.ExecuteReader();
                while (reader.Read()) list.Add(new CollectionResponse { Id = reader.GetString(0), Name = reader.GetString(1), Count = reader.GetInt32(2) });
            }
            return list;
        }

        public IEnumerable<string> GetCollectionFiles(string collectionId)
        {
            var list = new List<string>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"SELECT {Column.CollectionFiles.FileId} FROM {TableName.CollectionFiles} WHERE {Column.CollectionFiles.CollectionId} = $Id";
                command.Parameters.AddWithValue("$Id", collectionId);
                using var reader = command.ExecuteReader();
                while (reader.Read()) list.Add(reader.GetString(0));
            }
            return list;
        }

        public void ClearPicked()
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"DELETE FROM {TableName.ImagesPicked}";
                command.ExecuteNonQuery();
            }
        }

        public IEnumerable<string> GetPickedIds()
        {
            var list = new List<string>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"SELECT {Column.ImagesPicked.FileId} FROM {TableName.ImagesPicked}";
                using var reader = command.ExecuteReader();
                while (reader.Read()) list.Add(reader.GetString(0));
            }
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
            if (string.IsNullOrWhiteSpace(name)) 
            {
                // If name is empty, we can't create a valid path segment.
                // Return parentId if it exists, or throw if it's a base root.
                if (parentId != null) return parentId;
                throw new ArgumentException("Root path name cannot be empty");
            }

            // If it's a base root, 'name' is the full absolute path.
            // If it's a child root, 'name' is just the folder name.
            
            using (var checkCmd = connection.CreateCommand())
            {
                checkCmd.Transaction = transaction;
                if (parentId == null) checkCmd.CommandText = $"SELECT {Column.RootPaths.Id} FROM {TableName.RootPaths} WHERE {Column.RootPaths.ParentId} IS NULL AND {Column.RootPaths.Name} = $Name";
                else { checkCmd.CommandText = $"SELECT {Column.RootPaths.Id} FROM {TableName.RootPaths} WHERE {Column.RootPaths.ParentId} = $ParentId AND {Column.RootPaths.Name} = $Name"; checkCmd.Parameters.AddWithValue("$ParentId", parentId); }
                checkCmd.Parameters.AddWithValue("$Name", name);
                var existingId = checkCmd.ExecuteScalar() as string;
                if (existingId != null) return existingId;
            }

            // Special logic for Adoption: if we are about to create a CHILD that matches an existing BASE root path
            if (parentId != null)
            {
                string? parentPath = GetRootAbsolutePath(connection, parentId, transaction);
                if (parentPath != null)
                {
                    string fullPathToChild = Path.Combine(parentPath, name);
                    using (var adoptCmd = connection.CreateCommand())
                    {
                        adoptCmd.Transaction = transaction;
                        adoptCmd.CommandText = $"SELECT {Column.RootPaths.Id} FROM {TableName.RootPaths} WHERE {Column.RootPaths.ParentId} IS NULL AND {Column.RootPaths.Name} = $Path";
                        adoptCmd.Parameters.AddWithValue("$Path", fullPathToChild);
                        var existingBaseId = adoptCmd.ExecuteScalar() as string;
                        if (existingBaseId != null)
                        {
                            // Convert base root to child
                            using (var updateCmd = connection.CreateCommand())
                            {
                                updateCmd.Transaction = transaction;
                                updateCmd.CommandText = $"UPDATE {TableName.RootPaths} SET {Column.RootPaths.ParentId} = $ParentId, {Column.RootPaths.Name} = $Name WHERE {Column.RootPaths.Id} = $Id";
                                updateCmd.Parameters.AddWithValue("$ParentId", parentId);
                                updateCmd.Parameters.AddWithValue("$Name", name);
                                updateCmd.Parameters.AddWithValue("$Id", existingBaseId);
                                updateCmd.ExecuteNonQuery();
                            }
                            return existingBaseId;
                        }
                    }
                }
            }

            string newId = Guid.NewGuid().ToString();
            using (var insertCmd = connection.CreateCommand())
            {
                insertCmd.Transaction = transaction;
                insertCmd.CommandText = $"INSERT INTO {TableName.RootPaths} ({Column.RootPaths.Id}, {Column.RootPaths.ParentId}, {Column.RootPaths.Name}) VALUES ($Id, $ParentId, $Name)";
                insertCmd.Parameters.AddWithValue("$Id", newId);
                insertCmd.Parameters.AddWithValue("$ParentId", (object?)parentId ?? DBNull.Value);
                insertCmd.Parameters.AddWithValue("$Name", name);
                insertCmd.ExecuteNonQuery();
            }
            return newId;
        }

        public void UpsertFileEntry(FileEntry entry)
        {
            try 
            {
                using var connection = new SqliteConnection(_connectionString);
                connection.Open();
                using var transaction = connection.BeginTransaction();
                
                string baseName = Path.GetFileNameWithoutExtension(entry.FileName ?? "");

                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = $@"
                        INSERT INTO {TableName.FileEntry} ({Column.FileEntry.Id}, {Column.FileEntry.RootPathId}, {Column.FileEntry.FileName}, {Column.FileEntry.BaseName}, {Column.FileEntry.Size}, {Column.FileEntry.CreatedAt}, {Column.FileEntry.ModifiedAt})
                        VALUES ($Id, $RootPathId, $FileName, $BaseName, $Size, $CreatedAt, $ModifiedAt)
                        ON CONFLICT({Column.FileEntry.RootPathId}, {Column.FileEntry.FileName}) DO UPDATE SET {Column.FileEntry.Size} = excluded.{Column.FileEntry.Size}, {Column.FileEntry.CreatedAt} = excluded.{Column.FileEntry.CreatedAt}, {Column.FileEntry.ModifiedAt} = excluded.{Column.FileEntry.ModifiedAt}, {Column.FileEntry.BaseName} = excluded.{Column.FileEntry.BaseName};
                    ";
                    command.Parameters.AddWithValue("$Id", entry.Id);
                    command.Parameters.AddWithValue("$RootPathId", entry.RootPathId ?? (object)DBNull.Value);
                    command.Parameters.AddWithValue("$FileName", entry.FileName ?? (object)DBNull.Value);
                    command.Parameters.AddWithValue("$BaseName", baseName);
                    command.Parameters.AddWithValue("$Size", entry.Size);
                    command.Parameters.AddWithValue("$CreatedAt", entry.CreatedAt.ToString("o"));
                    command.Parameters.AddWithValue("$ModifiedAt", entry.ModifiedAt.ToString("o"));
                    command.ExecuteNonQuery();
                }
                
                string? actualId = null;
                using (var getIdCmd = connection.CreateCommand())
                {
                    getIdCmd.Transaction = transaction;
                    getIdCmd.CommandText = $"SELECT {Column.FileEntry.Id} FROM {TableName.FileEntry} WHERE {Column.FileEntry.RootPathId} = $RootPathId AND {Column.FileEntry.FileName} = $FileName";
                    getIdCmd.Parameters.AddWithValue("$RootPathId", entry.RootPathId ?? (object)DBNull.Value);
                    getIdCmd.Parameters.AddWithValue("$FileName", entry.FileName ?? (object)DBNull.Value);
                    actualId = getIdCmd.ExecuteScalar() as string;
                }

                if (actualId != null) {
                    using (var deleteCmd = connection.CreateCommand())
                    {
                        deleteCmd.Transaction = transaction;
                        deleteCmd.CommandText = $"DELETE FROM {TableName.Metadata} WHERE {Column.Metadata.FileId} = $FileId";
                        deleteCmd.Parameters.AddWithValue("$FileId", actualId);
                        deleteCmd.ExecuteNonQuery();
                    }
                }
                transaction.Commit();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error upserting file {entry.FileName}: {ex.Message}");
                throw;
            }
        }

        public string? GetFullFilePath(string fileId)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            using (var command = connection.CreateCommand())
            {
                command.CommandText = $@"
                    WITH RECURSIVE PathParts({Column.RootPaths.Id}, {Column.RootPaths.ParentId}, {Column.RootPaths.Name}) AS (
                        SELECT r.{Column.RootPaths.Id}, r.{Column.RootPaths.ParentId}, r.{Column.RootPaths.Name} 
                        FROM {TableName.RootPaths} r
                        JOIN {TableName.FileEntry} f ON f.{Column.FileEntry.RootPathId} = r.{Column.RootPaths.Id}
                        WHERE f.{Column.FileEntry.Id} = $FileId
                        UNION ALL
                        SELECT r.{Column.RootPaths.Id}, r.{Column.RootPaths.ParentId}, r.{Column.RootPaths.Name}
                        FROM {TableName.RootPaths} r
                        JOIN PathParts p ON r.{Column.RootPaths.Id} = p.{Column.RootPaths.ParentId}
                    )
                    SELECT {Column.RootPaths.Name}, (SELECT {Column.FileEntry.FileName} FROM {TableName.FileEntry} WHERE {Column.FileEntry.Id} = $FileId) as FileName
                    FROM PathParts";
                
                command.Parameters.AddWithValue("$FileId", fileId);
                
                var parts = new List<string>();
                string? fileName = null;
                
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    parts.Add(reader.GetString(0));
                    fileName = reader.GetString(1);
                }

                if (parts.Count == 0 || fileName == null) return null;

                parts.Reverse();
                // Manual join to avoid weirdness with Path.Combine and absolute segments
                // Resilience: some parts might be absolute paths if they were imported poorly
                // We take only the directory name if it's an absolute path but not the FIRST part.
                var cleanParts = new List<string>();
                for (int i = 0; i < parts.Count; i++)
                {
                    string p = parts[i];
                    if (i > 0 && Path.IsPathRooted(p)) cleanParts.Add(Path.GetFileName(p));
                    else cleanParts.Add(p);
                }

                string fullDir = string.Join("/", cleanParts.Select(p => p.Trim('/')));
                if (cleanParts[0].StartsWith("/")) fullDir = "/" + fullDir;
                
                string fullPath = fullDir + "/" + fileName;
                
                return fullPath;
            }
        }

        public string? GetFileId(string rootPathId, string fileName)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"SELECT {Column.FileEntry.Id} FROM {TableName.FileEntry} WHERE {Column.FileEntry.RootPathId} = $RootPathId AND {Column.FileEntry.FileName} = $FileName";
                command.Parameters.AddWithValue("$RootPathId", rootPathId);
                command.Parameters.AddWithValue("$FileName", fileName);
                return command.ExecuteScalar() as string;
            }
        }

        public (bool exists, DateTime? lastModified) GetExistingFileStatus(string fullPath, SqliteConnection? existingConnection = null)
        {
            var fileName = Path.GetFileName(fullPath);
            var dirPath = Path.GetDirectoryName(fullPath)?.TrimEnd(Path.DirectorySeparatorChar);
            if (dirPath == null) return (false, null);

            var connection = existingConnection;
            bool ownConnection = false;
            
            if (connection == null)
            {
                connection = new SqliteConnection(_connectionString);
                connection.Open();
                ownConnection = true;
            }

            try 
            {
                using (var command = connection.CreateCommand())
                {
                    command.CommandText = $@"
                        SELECT f.{Column.FileEntry.RootPathId}, f.{Column.FileEntry.ModifiedAt} 
                        FROM {TableName.FileEntry} f 
                        WHERE f.{Column.FileEntry.FileName} = $FileName";
                    command.Parameters.AddWithValue("$FileName", fileName);
                    
                    using var reader = command.ExecuteReader();
                    while (reader.Read())
                    {
                        string rootPathId = reader.GetString(0);
                        string modStr = reader.GetString(1);
                        
                        string? candidatePath = GetRootAbsolutePath(connection, rootPathId);
                        if (candidatePath != null && candidatePath.TrimEnd(Path.DirectorySeparatorChar) == dirPath) 
                        {
                            if (DateTime.TryParse(modStr, out var mod)) return (true, mod);
                            return (true, null);
                        }
                    }
                }
                return (false, null);
            }
            finally
            {
                if (ownConnection) connection.Dispose();
            }
        }

        public bool FileExists(string fullPath, SqliteConnection? existingConnection = null)
        {
            var fileName = Path.GetFileName(fullPath);
            var dirPath = Path.GetDirectoryName(fullPath)?.TrimEnd(Path.DirectorySeparatorChar);
            if (dirPath == null) return false;

            var connection = existingConnection;
            bool ownConnection = false;
            
            if (connection == null)
            {
                connection = new SqliteConnection(_connectionString);
                connection.Open();
                ownConnection = true;
            }

            try 
            {
                // 1. Quick check for filename
                using (var command = connection.CreateCommand())
                {
                    command.CommandText = $"SELECT {Column.FileEntry.RootPathId} FROM {TableName.FileEntry} WHERE {Column.FileEntry.FileName} = $FileName";
                    command.Parameters.AddWithValue("$FileName", fileName);
                    
                    using var reader = command.ExecuteReader();
                    while (reader.Read())
                    {
                        string rootPathId = reader.GetString(0);
                        // 2. Verify path matches for this candidate
                        string? candidatePath = GetRootAbsolutePath(connection, rootPathId);
                        if (candidatePath != null && candidatePath.TrimEnd(Path.DirectorySeparatorChar) == dirPath) return true;
                    }
                }
                return false;
            }
            finally
            {
                if (ownConnection) connection.Dispose();
            }
        }

        private string? GetRootAbsolutePath(SqliteConnection conn, string rootId, SqliteTransaction? transaction = null)
        {
            var parts = new List<string>();
            string currentId = rootId;
            var seen = new HashSet<string>();

            while (true)
            {
                if (!seen.Add(currentId))
                {
                    Console.WriteLine($"[DB] Cycle detected in RootPaths at ID {currentId}!");
                    break;
                }

                using var cmd = conn.CreateCommand();
                if (transaction != null) cmd.Transaction = transaction;
                cmd.CommandText = $"SELECT {Column.RootPaths.Name}, {Column.RootPaths.ParentId} FROM {TableName.RootPaths} WHERE {Column.RootPaths.Id} = $Id";
                cmd.Parameters.AddWithValue("$Id", currentId);
                using var reader = cmd.ExecuteReader();
                if (!reader.Read()) break;

                parts.Add(reader.GetString(0));
                if (reader.IsDBNull(1)) break;
                
                string nextId = reader.GetString(1);
                if (nextId == currentId) break; // Direct self-cycle safety
                currentId = nextId;
            }

            if (parts.Count == 0) return null;
            parts.Reverse();
            // Handle absolute paths starting with / on Linux
            string combined = Path.Combine(parts.ToArray());
            if (parts[0].StartsWith("/") && !combined.StartsWith("/")) combined = "/" + combined;
            return combined;
        }

        public void InsertMetadata(string fileId, IEnumerable<MetadataItem> metadata)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();
            foreach (var item in metadata) {
                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = $@"INSERT INTO {TableName.Metadata} ({Column.Metadata.FileId}, {Column.Metadata.Directory}, {Column.Metadata.Tag}, {Column.Metadata.Value}) VALUES ($FileId, $Directory, $Tag, $Value)";
                    command.Parameters.AddWithValue("$FileId", fileId);
                    command.Parameters.AddWithValue("$Directory", item.Directory ?? "");
                    command.Parameters.AddWithValue("$Tag", item.Tag ?? "");
                    string val = item.Value ?? "";
                    if (val.Length > 100) val = val.Substring(0, 100);
                    command.Parameters.AddWithValue("$Value", val);
                    command.ExecuteNonQuery();
                }
            }
            transaction.Commit();
        }

        public IEnumerable<RootPathResponse> GetAllRootPaths()
        {
            var items = new List<RootPathResponse>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = $@"
                    SELECT r.{Column.RootPaths.Id}, r.{Column.RootPaths.ParentId}, r.{Column.RootPaths.Name},
                           (SELECT COUNT(*) FROM {TableName.FileEntry} f WHERE f.{Column.FileEntry.RootPathId} = r.{Column.RootPaths.Id})
                    FROM {TableName.RootPaths} r";
                using var reader = command.ExecuteReader();
                while (reader.Read()) items.Add(new RootPathResponse { 
                    Id = reader.GetString(0), 
                    ParentId = reader.IsDBNull(1) ? null : reader.GetString(1), 
                    Name = reader.GetString(2),
                    ImageCount = reader.GetInt32(3)
                });
            }
            return items;
        }

        public IEnumerable<MetadataItemResponse> GetMetadata(string fileId)
        {
            var items = new List<MetadataItemResponse>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"SELECT {Column.Metadata.Directory}, {Column.Metadata.Tag}, {Column.Metadata.Value} FROM {TableName.Metadata} WHERE {Column.Metadata.FileId} = $FileId";
                command.Parameters.AddWithValue("$FileId", fileId);
                using var reader = command.ExecuteReader();
                while (reader.Read()) items.Add(new MetadataItemResponse { Directory = reader.IsDBNull(0) ? null : reader.GetString(0), Tag = reader.IsDBNull(1) ? null : reader.GetString(1), Value = reader.IsDBNull(2) ? null : reader.GetString(2) });
            }
            return items;
        }

        public void SetPicked(string fileId, bool isPicked)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                if (isPicked) command.CommandText = $"INSERT OR IGNORE INTO {TableName.ImagesPicked} ({Column.ImagesPicked.FileId}) VALUES ($Id)";
                else command.CommandText = $"DELETE FROM {TableName.ImagesPicked} WHERE {Column.ImagesPicked.FileId} = $Id";
                command.Parameters.AddWithValue("$Id", fileId);
                command.ExecuteNonQuery();
            }
        }

        public void SetRating(string fileId, int rating)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                if (rating > 0) {
                    command.CommandText = $@"INSERT INTO {TableName.ImageRatings} ({Column.ImageRatings.FileId}, {Column.ImageRatings.Rating}) VALUES ($Id, $Rating) ON CONFLICT({Column.ImageRatings.FileId}) DO UPDATE SET {Column.ImageRatings.Rating} = excluded.{Column.ImageRatings.Rating}";
                    command.Parameters.AddWithValue("$Rating", rating);
                } else command.CommandText = $"DELETE FROM {TableName.ImageRatings} WHERE {Column.ImageRatings.FileId} = $Id";
                command.Parameters.AddWithValue("$Id", fileId);
                command.ExecuteNonQuery();
            }
        }

        public IEnumerable<string> SearchMetadata(string tag, string value)
        {
            var ids = new List<string>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"SELECT DISTINCT {Column.Metadata.FileId} FROM {TableName.Metadata} WHERE {Column.Metadata.Tag} = $Tag AND {Column.Metadata.Value} = $Value";
                command.Parameters.AddWithValue("$Tag", tag);
                command.Parameters.AddWithValue("$Value", value);
                using var reader = command.ExecuteReader();
                while (reader.Read()) ids.Add(reader.GetString(0));
            }
            return ids;
        }
    }
}
