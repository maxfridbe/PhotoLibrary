using System;
using System.IO;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using static PhotoLibrary.TableConstants;

namespace PhotoLibrary
{
    public class PreviewManager
    {
        private readonly string _connectionString;
        private readonly ILogger<PreviewManager> _logger;
        public string DbPath { get; private set; }

        public PreviewManager(string dbPath, ILogger<PreviewManager> logger)
        {
            DbPath = dbPath;
            _connectionString = $"Data Source={dbPath}";
            _logger = logger;
        }

        public void Initialize()
        {
            if (!File.Exists(DbPath))
            {
                _logger.LogWarning("Previews database not found at {Path}. Creating a new one.", DbPath);
            }

            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            using (var walCommand = connection.CreateCommand())
            {
                walCommand.CommandText = "PRAGMA journal_mode=WAL;";
                walCommand.ExecuteNonQuery();
            }

            // Check if we need to migrate (simple check: does the Hash column exist?)
            bool hasHash = false;
            try 
            {
                using var cmd = connection.CreateCommand();
                cmd.CommandText = $"SELECT {Column.Previews.Hash} FROM {TableName.Previews} LIMIT 1";
                cmd.ExecuteNonQuery();
                hasHash = true;
            }
            catch { }

            if (!hasHash)
            {
                // If the table exists but has no Hash column, or doesn't exist, we recreate to enforce the new PK
                // This effectively clears the cache, which is safer than trying to backfill hashes we don't have here.
                using var dropCmd = connection.CreateCommand();
                dropCmd.CommandText = $"DROP TABLE IF EXISTS {TableName.Previews}";
                dropCmd.ExecuteNonQuery();
            }

            using (var command = connection.CreateCommand())
            {
                command.CommandText = $@"
                    CREATE TABLE IF NOT EXISTS {TableName.Previews} (
                        {Column.Previews.Hash} TEXT,
                        {Column.Previews.LongEdge} INTEGER,
                        {Column.Previews.Data} BLOB,
                        PRIMARY KEY ({Column.Previews.Hash}, {Column.Previews.LongEdge})
                    );
                    CREATE INDEX IF NOT EXISTS IDX_Previews_Hash ON {TableName.Previews}({Column.Previews.Hash});
                ";
                command.ExecuteNonQuery();
            }
        }

        public bool HasPreview(string hash, int longEdge)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"SELECT 1 FROM {TableName.Previews} WHERE {Column.Previews.Hash} = $Hash AND {Column.Previews.LongEdge} = $LongEdge";
                command.Parameters.AddWithValue("$Hash", hash);
                command.Parameters.AddWithValue("$LongEdge", longEdge);

                return command.ExecuteScalar() != null;
            }
        }

        public void SavePreview(string hash, int longEdge, byte[] data)
        {
            try {
                using var connection = new SqliteConnection(_connectionString);
                connection.Open();
                using var transaction = connection.BeginTransaction();

                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = $@"
                        INSERT INTO {TableName.Previews} ({Column.Previews.Hash}, {Column.Previews.LongEdge}, {Column.Previews.Data})
                        VALUES ($Hash, $LongEdge, $Data)
                        ON CONFLICT({Column.Previews.Hash}, {Column.Previews.LongEdge}) DO UPDATE SET {Column.Previews.Data} = excluded.{Column.Previews.Data};
                    ";
                    command.Parameters.AddWithValue("$Hash", hash);
                    command.Parameters.AddWithValue("$LongEdge", longEdge);
                    command.Parameters.AddWithValue("$Data", data);

                    command.ExecuteNonQuery();
                }
                transaction.Commit();
                // _logger.LogDebug("Saved preview for hash {Hash} size {Size}", hash, longEdge);
            } catch (Exception ex) {
                _logger.LogError(ex, "Failed to save preview for hash {Hash}", hash);
            }
        }

        public byte[]? GetPreviewData(string hash, int longEdge)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"SELECT {Column.Previews.Data} FROM {TableName.Previews} WHERE {Column.Previews.Hash} = $Hash AND {Column.Previews.LongEdge} = $LongEdge";
                command.Parameters.AddWithValue("$Hash", hash);
                command.Parameters.AddWithValue("$LongEdge", longEdge);

                var res = command.ExecuteScalar() as byte[];
                if (res == null) _logger.LogDebug("Preview miss for hash {Hash} size {Size}", hash, longEdge);
                return res;
            }
        }

        public void DeletePreviewsByHash(string hash)
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"DELETE FROM {TableName.Previews} WHERE {Column.Previews.Hash} = $Hash";
                command.Parameters.AddWithValue("$Hash", hash);
                command.ExecuteNonQuery();
            }
        }
    }
}