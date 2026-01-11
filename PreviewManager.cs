using System;
using System.IO;
using Microsoft.Data.Sqlite;

namespace PhotoLibrary
{
    public class PreviewManager
    {
        private readonly string _connectionString;

        public PreviewManager(string dbPath)
        {
            _connectionString = $"Data Source={dbPath}";
        }

        public void Initialize()
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            using (var walCommand = connection.CreateCommand())
            {
                walCommand.CommandText = "PRAGMA journal_mode=WAL;";
                walCommand.ExecuteNonQuery();
            }

            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
                    CREATE TABLE IF NOT EXISTS Previews (
                        FileId TEXT,
                        LongEdge INTEGER,
                        Data BLOB,
                        PRIMARY KEY (FileId, LongEdge)
                    );
                ";
                command.ExecuteNonQuery();
            }
        }

        public bool HasPreview(string fileId, int longEdge)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            var command = connection.CreateCommand();
            command.CommandText = "SELECT 1 FROM Previews WHERE FileId = $FileId AND LongEdge = $LongEdge";
            command.Parameters.AddWithValue("$FileId", fileId);
            command.Parameters.AddWithValue("$LongEdge", longEdge);

            return command.ExecuteScalar() != null;
        }

        public void SavePreview(string fileId, int longEdge, byte[] data)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();

            var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = @"
                INSERT INTO Previews (FileId, LongEdge, Data)
                VALUES ($FileId, $LongEdge, $Data)
                ON CONFLICT(FileId, LongEdge) DO UPDATE SET Data = excluded.Data;
            ";
            command.Parameters.AddWithValue("$FileId", fileId);
            command.Parameters.AddWithValue("$LongEdge", longEdge);
            command.Parameters.AddWithValue("$Data", data);

            command.ExecuteNonQuery();
            transaction.Commit();
        }

        public byte[]? GetPreviewData(string fileId, int longEdge)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            var command = connection.CreateCommand();
            command.CommandText = "SELECT Data FROM Previews WHERE FileId = $FileId AND LongEdge = $LongEdge";
            command.Parameters.AddWithValue("$FileId", fileId);
            command.Parameters.AddWithValue("$LongEdge", longEdge);

            return command.ExecuteScalar() as byte[];
        }
    }
}
