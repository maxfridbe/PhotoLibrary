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

            var command = connection.CreateCommand();
            command.CommandText = @"
                CREATE TABLE IF NOT EXISTS RootPaths (
                    Id TEXT PRIMARY KEY,
                    ParentId TEXT,
                    Name TEXT,
                    FOREIGN KEY(ParentId) REFERENCES RootPaths(Id),
                    UNIQUE(ParentId, Name)
                );

                CREATE TABLE IF NOT EXISTS FileEntry (
                    Id TEXT PRIMARY KEY,
                    RootPathId TEXT,
                    FileName TEXT,
                    Size INTEGER,
                    CreatedAt TEXT,
                    ModifiedAt TEXT,
                    FOREIGN KEY(RootPathId) REFERENCES RootPaths(Id),
                    UNIQUE(RootPathId, FileName)
                );

                CREATE TABLE IF NOT EXISTS Metadata (
                    FileId TEXT,
                    Directory TEXT,
                    Tag TEXT,
                    Value TEXT,
                    FOREIGN KEY(FileId) REFERENCES FileEntry(Id)
                );

                CREATE INDEX IF NOT EXISTS IDX_Metadata_FileId ON Metadata(FileId);
            ";
            command.ExecuteNonQuery();
        }

        // Creates a top-level root (ParentId IS NULL)
        public string GetOrCreateBaseRoot(string absolutePath)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();
            
            string id = EnsureRootPathExists(connection, transaction, null, absolutePath);
            
            transaction.Commit();
            return id;
        }

        // Creates a child node
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
            
            if (parentId == null)
            {
                checkCmd.CommandText = "SELECT Id FROM RootPaths WHERE ParentId IS NULL AND Name = $Name";
            }
            else
            {
                checkCmd.CommandText = "SELECT Id FROM RootPaths WHERE ParentId = $ParentId AND Name = $Name";
                checkCmd.Parameters.AddWithValue("$ParentId", parentId);
            }
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
                ON CONFLICT(RootPathId, FileName) DO UPDATE SET
                    Size = excluded.Size,
                    CreatedAt = excluded.CreatedAt,
                    ModifiedAt = excluded.ModifiedAt;
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

            if (actualId != null)
            {
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

            foreach (var item in items)
            {
                var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = @"
                    INSERT INTO Metadata (FileId, Directory, Tag, Value)
                    VALUES ($FileId, $Directory, $Tag, $Value)
                ";
                command.Parameters.AddWithValue("$FileId", fileId);
                command.Parameters.AddWithValue("$Directory", item.Directory ?? "");
                command.Parameters.AddWithValue("$Tag", item.Tag ?? "");
                command.Parameters.AddWithValue("$Value", item.Value ?? "");
                command.ExecuteNonQuery();
            }

            transaction.Commit();
        }

        public IEnumerable<FileEntry> GetAllPhotos()
        {
            var entries = new List<FileEntry>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            
            var command = connection.CreateCommand();
            command.CommandText = "SELECT Id, RootPathId, FileName, Size, CreatedAt, ModifiedAt FROM FileEntry ORDER BY CreatedAt DESC LIMIT 1000"; // Limit for perf

            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                entries.Add(new FileEntry
                {
                    Id = reader.GetString(0),
                    RootPathId = reader.IsDBNull(1) ? null : reader.GetString(1),
                    FileName = reader.IsDBNull(2) ? null : reader.GetString(2),
                    Size = reader.GetInt64(3),
                    CreatedAt = DateTime.Parse(reader.GetString(4)),
                    ModifiedAt = DateTime.Parse(reader.GetString(5))
                });
            }
            return entries;
        }

        public IEnumerable<MetadataItem> GetMetadata(string fileId)
        {
            var items = new List<MetadataItem>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            
            var command = connection.CreateCommand();
            command.CommandText = "SELECT Directory, Tag, Value FROM Metadata WHERE FileId = $FileId";
            command.Parameters.AddWithValue("$FileId", fileId);

            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                items.Add(new MetadataItem
                {
                    Directory = reader.IsDBNull(0) ? null : reader.GetString(0),
                    Tag = reader.IsDBNull(1) ? null : reader.GetString(1),
                    Value = reader.IsDBNull(2) ? null : reader.GetString(2)
                });
            }
            return items;
        }

        public IEnumerable<RootPathEntry> GetAllRootPaths()
        {
            var items = new List<RootPathEntry>();
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            
            var command = connection.CreateCommand();
            command.CommandText = "SELECT Id, ParentId, Name FROM RootPaths";

            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                items.Add(new RootPathEntry
                {
                    Id = reader.GetString(0),
                    ParentId = reader.IsDBNull(1) ? null : reader.GetString(1),
                    Name = reader.GetString(2)
                });
            }
            return items;
        }
    }
}