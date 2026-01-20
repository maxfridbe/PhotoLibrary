using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace PhotoLibrary.Backend;

public class PreviewManager : IPreviewManager
{
    private readonly string _connectionString;
    private readonly ILogger<PreviewManager> _logger;
    private readonly SemaphoreSlim _dbLock = new(1, 1);
    public string DbPath { get; private set; }

    public PreviewManager(string dbPath, ILogger<PreviewManager> logger)
    {
        DbPath = dbPath;
        _connectionString = $"Data Source={dbPath};Cache=Shared;Mode=ReadWriteCreate;Default Timeout=30;";
        _logger = logger;
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

        // Check if we need to migrate (simple check: does the Hash column exist?)
        bool hasHash = false;
        try 
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"SELECT Hash FROM Previews LIMIT 1";
            cmd.ExecuteNonQuery();
            hasHash = true;
        }
        catch { }

        if (!hasHash)
        {
            using var dropCmd = connection.CreateCommand();
            dropCmd.CommandText = $"DROP TABLE IF EXISTS Previews";
            dropCmd.ExecuteNonQuery();
        }

        using (var command = connection.CreateCommand())
        {
            command.CommandText = $@"
                CREATE TABLE IF NOT EXISTS Previews (
                    Hash TEXT,
                    LongEdge INTEGER,
                    Data BLOB,
                    PRIMARY KEY (Hash, LongEdge)
                );
                CREATE INDEX IF NOT EXISTS IDX_Previews_Hash ON Previews(Hash);
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
            command.CommandText = $"SELECT 1 FROM Previews WHERE Hash = $Hash AND LongEdge = $LongEdge";
            command.Parameters.AddWithValue("$Hash", hash);
            command.Parameters.AddWithValue("$LongEdge", longEdge);

            return command.ExecuteScalar() != null;
        }
    }

    public void SavePreview(string hash, int longEdge, byte[] data)
    {
        _dbLock.Wait();
        try {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();

            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = $@"
                    INSERT INTO Previews (Hash, LongEdge, Data)
                    VALUES ($Hash, $LongEdge, $Data)
                    ON CONFLICT(Hash, LongEdge) DO UPDATE SET Data = excluded.Data;
                ";
                command.Parameters.AddWithValue("$Hash", hash);
                command.Parameters.AddWithValue("$LongEdge", longEdge);
                command.Parameters.AddWithValue("$Data", data);

                command.ExecuteNonQuery();
            }
            transaction.Commit();
        } catch (Exception ex) {
            _logger.LogError(ex, "Failed to save preview for hash {Hash}", hash);
        } finally {
            _dbLock.Release();
        }
    }

    public byte[]? GetPreviewData(string hash, int longEdge)
    {
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        using (var command = connection.CreateCommand())
        {
            command.CommandText = $"SELECT Data FROM Previews WHERE Hash = $Hash AND LongEdge = $LongEdge";
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
            command.CommandText = $"DELETE FROM Previews WHERE Hash = $Hash";
            command.Parameters.AddWithValue("$Hash", hash);
            command.ExecuteNonQuery();
        }
    }

    public int GetTotalUniqueHashes()
    {
        if (!File.Exists(DbPath)) return 0;

        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(DISTINCT Hash) FROM Previews";
        return Convert.ToInt32(command.ExecuteScalar());
    }
}