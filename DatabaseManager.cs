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
                CREATE TABLE IF NOT EXISTS Directories (
                    Id TEXT PRIMARY KEY,
                    ParentId TEXT,
                    Name TEXT,
                    FOREIGN KEY(ParentId) REFERENCES Directories(Id),
                    UNIQUE(ParentId, Name)
                );

                -- Root directory handling (Name is empty or /)
                -- We'll handle uniqueness via code or careful constraints.
                -- SQLite treats NULLs as distinct for UNIQUE constraints usually, 
                -- so strict root enforcement might need specific logic.

                CREATE TABLE IF NOT EXISTS FileEntry (
                    Id TEXT PRIMARY KEY,
                    DirectoryId TEXT,
                    FileName TEXT,
                    RelativePath TEXT,
                    Size INTEGER,
                    CreatedAt TEXT,
                    ModifiedAt TEXT,
                    FOREIGN KEY(DirectoryId) REFERENCES Directories(Id),
                    UNIQUE(DirectoryId, FileName)
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

        public string GetOrCreateDirectory(string fullPath)
        {
            // Normalize path separators
            fullPath = Path.GetFullPath(fullPath);
            string[] parts = fullPath.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
            
            // Handle root (Linux starts with /, parts doesn't contain it)
            // We'll treat the system root as a directory with Name="/" (or empty) and ParentId=NULL
            
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();

            string? currentParentId = null;
            
            // Determine root name based on OS or convention. For Linux, root is /. 
            // Path.GetPathRoot("/") returns "/".
            string rootName = Path.GetPathRoot(fullPath); 
            // On linux rootName is "/"
            
            // Ensure root exists
            currentParentId = EnsureDirectoryExists(connection, transaction, null, rootName);

            foreach (var part in parts)
            {
                currentParentId = EnsureDirectoryExists(connection, transaction, currentParentId, part);
            }

            transaction.Commit();
            return currentParentId!;
        }

        private string EnsureDirectoryExists(SqliteConnection connection, SqliteTransaction transaction, string? parentId, string name)
        {
            // Check if exists
            var checkCmd = connection.CreateCommand();
            checkCmd.Transaction = transaction;
            
            if (parentId == null)
            {
                checkCmd.CommandText = "SELECT Id FROM Directories WHERE ParentId IS NULL AND Name = $Name";
            }
            else
            {
                checkCmd.CommandText = "SELECT Id FROM Directories WHERE ParentId = $ParentId AND Name = $Name";
                checkCmd.Parameters.AddWithValue("$ParentId", parentId);
            }
            checkCmd.Parameters.AddWithValue("$Name", name);
            
            var existingId = checkCmd.ExecuteScalar() as string;
            if (existingId != null)
            {
                return existingId;
            }

            // Create
            var newId = Guid.NewGuid().ToString();
            var insertCmd = connection.CreateCommand();
            insertCmd.Transaction = transaction;
            insertCmd.CommandText = "INSERT INTO Directories (Id, ParentId, Name) VALUES ($Id, $ParentId, $Name)";
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
                INSERT INTO FileEntry (Id, DirectoryId, FileName, RelativePath, Size, CreatedAt, ModifiedAt)
                VALUES ($Id, $DirectoryId, $FileName, $RelativePath, $Size, $CreatedAt, $ModifiedAt)
                ON CONFLICT(DirectoryId, FileName) DO UPDATE SET
                    Size = excluded.Size,
                    CreatedAt = excluded.CreatedAt,
                    ModifiedAt = excluded.ModifiedAt;
            ";

            command.Parameters.AddWithValue("$Id", entry.Id);
            command.Parameters.AddWithValue("$DirectoryId", entry.DirectoryId);
            command.Parameters.AddWithValue("$FileName", entry.FileName);
            command.Parameters.AddWithValue("$RelativePath", entry.RelativePath);
            command.Parameters.AddWithValue("$Size", entry.Size);
            command.Parameters.AddWithValue("$CreatedAt", entry.CreatedAt.ToString("o"));
            command.Parameters.AddWithValue("$ModifiedAt", entry.ModifiedAt.ToString("o"));

            command.ExecuteNonQuery();

            // Clear old metadata
            // Need to get the ID again? 
            // If we inserted, entry.Id is correct. 
            // If we updated, the ID in DB is the OLD one, not entry.Id (which is new random guid).
            // We must fetch the actual ID to be safe.
            
            var getIdCmd = connection.CreateCommand();
            getIdCmd.Transaction = transaction;
            getIdCmd.CommandText = "SELECT Id FROM FileEntry WHERE DirectoryId = $DirectoryId AND FileName = $FileName";
            getIdCmd.Parameters.AddWithValue("$DirectoryId", entry.DirectoryId);
            getIdCmd.Parameters.AddWithValue("$FileName", entry.FileName);
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

        public string? GetFileId(string directoryId, string fileName)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            var command = connection.CreateCommand();
            command.CommandText = "SELECT Id FROM FileEntry WHERE DirectoryId = $DirectoryId AND FileName = $FileName";
            command.Parameters.AddWithValue("$DirectoryId", directoryId);
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
                command.Parameters.AddWithValue("$Directory", item.Directory);
                command.Parameters.AddWithValue("$Tag", item.Tag);
                command.Parameters.AddWithValue("$Value", item.Value ?? "");
                command.ExecuteNonQuery();
            }

            transaction.Commit();
        }
    }
}