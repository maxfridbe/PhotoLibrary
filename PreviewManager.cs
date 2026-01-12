using System;
using System.IO;
using Microsoft.Data.Sqlite;
using static PhotoLibrary.TableConstants;

namespace PhotoLibrary
{
    public class PreviewManager
    {
        private readonly string _connectionString;
        public string DbPath { get; private set; }

        public PreviewManager(string dbPath)
        {
            DbPath = dbPath;
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
                command.CommandText = $@"
                    CREATE TABLE IF NOT EXISTS {TableName.Previews} (
                        {Column.Previews.FileId} TEXT,
                        {Column.Previews.LongEdge} INTEGER,
                        {Column.Previews.Data} BLOB,
                        PRIMARY KEY ({Column.Previews.FileId}, {Column.Previews.LongEdge})
                    );
                ";
                command.ExecuteNonQuery();
            }
        }

        public bool HasPreview(string fileId, int longEdge)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"SELECT 1 FROM {TableName.Previews} WHERE {Column.Previews.FileId} = $FileId AND {Column.Previews.LongEdge} = $LongEdge";
                command.Parameters.AddWithValue("$FileId", fileId);
                command.Parameters.AddWithValue("$LongEdge", longEdge);

                return command.ExecuteScalar() != null;
            }
        }

        public void SavePreview(string fileId, int longEdge, byte[] data)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();

            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = $@"
                    INSERT INTO {TableName.Previews} ({Column.Previews.FileId}, {Column.Previews.LongEdge}, {Column.Previews.Data})
                    VALUES ($FileId, $LongEdge, $Data)
                    ON CONFLICT({Column.Previews.FileId}, {Column.Previews.LongEdge}) DO UPDATE SET {Column.Previews.Data} = excluded.{Column.Previews.Data};
                ";
                command.Parameters.AddWithValue("$FileId", fileId);
                command.Parameters.AddWithValue("$LongEdge", longEdge);
                command.Parameters.AddWithValue("$Data", data);

                command.ExecuteNonQuery();
            }
            transaction.Commit();
        }

        public byte[]? GetPreviewData(string fileId, int longEdge)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"SELECT {Column.Previews.Data} FROM {TableName.Previews} WHERE {Column.Previews.FileId} = $FileId AND {Column.Previews.LongEdge} = $LongEdge";
                command.Parameters.AddWithValue("$FileId", fileId);
                command.Parameters.AddWithValue("$LongEdge", longEdge);

                return command.ExecuteScalar() as byte[];
            }
        }
    }
}