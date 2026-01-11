using System;
using System.Collections.Generic;
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
                CREATE TABLE IF NOT EXISTS FileEntry (
                    Id TEXT PRIMARY KEY,
                    RootPath TEXT,
                    FileName TEXT,
                    RelativePath TEXT,
                    FullPath TEXT UNIQUE,
                    Size INTEGER,
                    CreatedAt TEXT,
                    ModifiedAt TEXT
                );

                CREATE TABLE IF NOT EXISTS Metadata (
                    FileId TEXT,
                    Directory TEXT,
                    Tag TEXT,
                    Value TEXT,
                    FOREIGN KEY(FileId) REFERENCES FileEntry(Id)
                );

                CREATE INDEX IF NOT EXISTS IDX_FileEntry_FullPath ON FileEntry(FullPath);
                CREATE INDEX IF NOT EXISTS IDX_Metadata_FileId ON Metadata(FileId);
            ";
            command.ExecuteNonQuery();
        }

        public void UpsertFileEntry(FileEntry entry)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            using var transaction = connection.BeginTransaction();
            var command = connection.CreateCommand();
            command.Transaction = transaction;

            // Check if exists to preserve ID if we were doing a more complex sync, 
            // but here we might want to overwrite or ignore. 
            // For now, let's Replace.
            
            command.CommandText = @"
                INSERT INTO FileEntry (Id, RootPath, FileName, RelativePath, FullPath, Size, CreatedAt, ModifiedAt)
                VALUES ($Id, $RootPath, $FileName, $RelativePath, $FullPath, $Size, $CreatedAt, $ModifiedAt)
                ON CONFLICT(FullPath) DO UPDATE SET
                    RootPath = excluded.RootPath,
                    FileName = excluded.FileName,
                    RelativePath = excluded.RelativePath,
                    Size = excluded.Size,
                    CreatedAt = excluded.CreatedAt,
                    ModifiedAt = excluded.ModifiedAt;
            ";

            command.Parameters.AddWithValue("$Id", entry.Id);
            command.Parameters.AddWithValue("$RootPath", entry.RootPath);
            command.Parameters.AddWithValue("$FileName", entry.FileName);
            command.Parameters.AddWithValue("$RelativePath", entry.RelativePath);
            command.Parameters.AddWithValue("$FullPath", entry.FullPath);
            command.Parameters.AddWithValue("$Size", entry.Size);
            command.Parameters.AddWithValue("$CreatedAt", entry.CreatedAt.ToString("o"));
            command.Parameters.AddWithValue("$ModifiedAt", entry.ModifiedAt.ToString("o"));

            command.ExecuteNonQuery();

            // Clear old metadata
            var deleteCmd = connection.CreateCommand();
            deleteCmd.Transaction = transaction;
            deleteCmd.CommandText = "DELETE FROM Metadata WHERE FileId = (SELECT Id FROM FileEntry WHERE FullPath = $FullPath)";
            deleteCmd.Parameters.AddWithValue("$FullPath", entry.FullPath);
            deleteCmd.ExecuteNonQuery();
            
            transaction.Commit();
        }
        
        // Helper to get ID if needed, though we usually generate it before insert in this logic.
        // Actually, if we did an ON CONFLICT UPDATE, the ID might be the OLD one if we didn't update it. 
        // Wait, "ON CONFLICT(FullPath) DO UPDATE SET Id = excluded.Id" isn't there, so ID remains old.
        // We need to fetch the actual ID to insert metadata against it.
        
        public string? GetFileId(string fullPath)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            command.CommandText = "SELECT Id FROM FileEntry WHERE FullPath = $FullPath";
            command.Parameters.AddWithValue("$FullPath", fullPath);
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
                command.Parameters.AddWithValue("$Directory", item.Directory);
                command.Parameters.AddWithValue("$Tag", item.Tag);
                command.Parameters.AddWithValue("$Value", item.Value ?? "");
                command.ExecuteNonQuery();
            }

            transaction.Commit();
        }
    }
}
