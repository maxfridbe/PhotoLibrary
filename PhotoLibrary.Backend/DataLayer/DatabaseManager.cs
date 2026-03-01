using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.IO.Hashing;
using System.Collections.Concurrent;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using System.Text.Json;
using static PhotoLibrary.Backend.TableConstants;

namespace PhotoLibrary.Backend;

// REQ-ARCH-00005
public class DatabaseManager : IDatabaseManager
{
    private readonly string _connectionString;
    private readonly ILogger<DatabaseManager> _logger;
    private readonly PathManager _pm = new();
    private readonly ConcurrentDictionary<string, string> _hashCache = new();
    private static readonly SemaphoreSlim _writeLock = new(1, 1);
    public string DbPath { get; }

    private Action<string, string>? _onFolderCreated;
    public void RegisterFolderCreatedHandler(Action<string, string> handler) => _onFolderCreated = handler;

    public DatabaseManager(string dbPath, ILogger<DatabaseManager> logger)
    {
        DbPath = dbPath;
        _connectionString = $"Data Source={dbPath};Mode=ReadWriteCreate;Default Timeout=30;";
        _logger = logger;
    }

    public void ClearCaches()
    {
        _hashCache.Clear();
    }

    public SqliteConnection GetOpenConnection()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return connection;
    }

    public SqliteTransaction BeginTransaction(SqliteConnection connection)
    {
        return connection.BeginTransaction();
    }

    public async Task ExecuteWriteAsync(Func<SqliteConnection, SqliteTransaction, Task> action)
    {
        await _writeLock.WaitAsync();
        try
        {
            using var connection = GetOpenConnection();
            using var transaction = connection.BeginTransaction();
            try
            {
                await action(connection, transaction);
                transaction.Commit();
            }
            catch
            {
                transaction.Rollback();
                throw;
            }
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public void ExecuteWrite(Action<SqliteConnection, SqliteTransaction> action)
    {
        _writeLock.Wait();
        try
        {
            using var connection = GetOpenConnection();
            using var transaction = connection.BeginTransaction();
            try
            {
                action(connection, transaction);
                transaction.Commit();
            }
            catch
            {
                transaction.Rollback();
                throw;
            }
        }
        finally
        {
            _writeLock.Release();
        }
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
                {Column.RootPaths.Annotation} TEXT,
                {Column.RootPaths.Color} TEXT,
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
                {Column.FileEntry.Hash} TEXT,
                RecordTouched INTEGER DEFAULT 0,
                FOREIGN KEY({Column.FileEntry.RootPathId}) REFERENCES {TableName.RootPaths}({Column.RootPaths.Id}),
                UNIQUE({Column.FileEntry.RootPathId}, {Column.FileEntry.FileName})
            );",
            $@"CREATE TABLE IF NOT EXISTS {TableName.Metadata} (
                {Column.Metadata.FileId} TEXT PRIMARY KEY,
                {Column.Metadata.Data} TEXT,
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
            $@"CREATE TABLE IF NOT EXISTS {TableName.Settings} (
                {Column.Settings.Key} TEXT PRIMARY KEY,
                {Column.Settings.Value} TEXT
            );",
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

        // --- Migration: Row-based Metadata to JSON-based ---
        try
        {
            bool needsMigration = false;
            using (var checkCmd = connection.CreateCommand())
            {
                checkCmd.CommandText = "PRAGMA table_info(Metadata);";
                using var reader = checkCmd.ExecuteReader();
                while (reader.Read())
                {
                    if (reader.GetString(1) == "Directory") { needsMigration = true; break; }
                }
            }

            if (needsMigration)
            {
                _logger?.LogInformation("[DB] Migrating Metadata table to JSON format (this may take a while)...");
                
                // 1. Rename old table
                using (var renameCmd = connection.CreateCommand())
                {
                    renameCmd.CommandText = "ALTER TABLE Metadata RENAME TO Metadata_Old;";
                    renameCmd.ExecuteNonQuery();
                }

                // 2. Create new table (already handled by 'schema' loop above if we did it right, but let's be explicit)
                using (var createCmd = connection.CreateCommand())
                {
                    createCmd.CommandText = $@"CREATE TABLE Metadata (
                        {Column.Metadata.FileId} TEXT PRIMARY KEY,
                        {Column.Metadata.Data} TEXT,
                        FOREIGN KEY({Column.Metadata.FileId}) REFERENCES {TableName.FileEntry}({Column.FileEntry.Id})
                    );";
                    createCmd.ExecuteNonQuery();
                }

                // 3. Perform Migration in batches to avoid locking issues
                var fileIds = new List<string>();
                using (var getIds = connection.CreateCommand())
                {
                    getIds.CommandText = "SELECT DISTINCT FileId FROM Metadata_Old;";
                    using var reader = getIds.ExecuteReader();
                    while (reader.Read()) fileIds.Add(reader.GetString(0));
                }

                _logger?.LogInformation("[DB] Processing {Count} files for metadata migration...", fileIds.Count);
                int count = 0;
                var batchSize = 1000;
                for (int i = 0; i < fileIds.Count; i += batchSize)
                {
                    var batch = fileIds.Skip(i).Take(batchSize).ToList();
                    using var transaction = connection.BeginTransaction();
                    try
                    {
                        foreach (var fId in batch)
                        {
                            var data = new Dictionary<string, Dictionary<string, string>>();
                            using (var getRows = connection.CreateCommand())
                            {
                                getRows.Transaction = transaction;
                                getRows.CommandText = "SELECT Directory, Tag, Value FROM Metadata_Old WHERE FileId = $Id;";
                                getRows.Parameters.AddWithValue("$Id", fId);
                                using var reader = getRows.ExecuteReader();
                                while (reader.Read())
                                {
                                    string dir = reader.GetString(0);
                                    string tag = reader.GetString(1);
                                    string val = reader.GetString(2);
                                    if (!data.ContainsKey(dir)) data[dir] = new Dictionary<string, string>();
                                    data[dir][tag] = val;
                                }
                            }

                            using (var insert = connection.CreateCommand())
                            {
                                insert.Transaction = transaction;
                                insert.CommandText = "INSERT INTO Metadata (FileId, Data) VALUES ($Id, $Data);";
                                insert.Parameters.AddWithValue("$Id", fId);
                                insert.Parameters.AddWithValue("$Data", JsonSerializer.Serialize(data));
                                insert.ExecuteNonQuery();
                            }
                            count++;
                        }
                        transaction.Commit();
                        _logger?.LogInformation("[DB] Migrated {Count} / {Total} files...", count, fileIds.Count);
                    }
                    catch
                    {
                        transaction.Rollback();
                        throw;
                    }
                }

                // 4. Drop old table
                using (var dropCmd = connection.CreateCommand())
                {
                    dropCmd.CommandText = "DROP TABLE Metadata_Old;";
                    dropCmd.ExecuteNonQuery();
                }
                
                _logger?.LogInformation("[DB] Metadata migration complete. Reclaiming space (VACUUM)...");
                using (var vacuumCmd = connection.CreateCommand())
                {
                    vacuumCmd.CommandText = "VACUUM;";
                    vacuumCmd.ExecuteNonQuery();
                }
                _logger?.LogInformation("[DB] Database optimized.");
            }
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "Metadata migration failed.");
        }

        // Add Expression Indexes for performance on common fields
        try
        {
            string[] expressIdxs = {
                $"CREATE INDEX IF NOT EXISTS IDX_Metadata_Model ON Metadata(json_extract({Column.Metadata.Data}, '$.\"Exif IFD0\".Model'));",
                $"CREATE INDEX IF NOT EXISTS IDX_Metadata_Make ON Metadata(json_extract({Column.Metadata.Data}, '$.\"Exif IFD0\".Make'));",
                $"CREATE INDEX IF NOT EXISTS IDX_Metadata_DateOriginal ON Metadata(json_extract({Column.Metadata.Data}, '$.\"Exif SubIFD\".\"Date/Time Original\"'));",
                $"CREATE INDEX IF NOT EXISTS IDX_Metadata_FNumber ON Metadata(json_extract({Column.Metadata.Data}, '$.\"Exif SubIFD\".\"F-Number\"'));",
                $"CREATE INDEX IF NOT EXISTS IDX_Metadata_ISO ON Metadata(json_extract({Column.Metadata.Data}, '$.\"Exif SubIFD\".\"ISO Speed Ratings\"'));",
                $"CREATE INDEX IF NOT EXISTS IDX_Metadata_FocalLength ON Metadata(json_extract({Column.Metadata.Data}, '$.\"Exif SubIFD\".\"Focal Length\"'));",
                $"CREATE INDEX IF NOT EXISTS IDX_Metadata_LensModel ON Metadata(json_extract({Column.Metadata.Data}, '$.\"Exif SubIFD\".\"Lens Model\"'));",
                $"CREATE INDEX IF NOT EXISTS IDX_Metadata_GPSLat ON Metadata(json_extract({Column.Metadata.Data}, '$.GPS.\"GPS Latitude\"'));",
                $"CREATE INDEX IF NOT EXISTS IDX_Metadata_GPSLng ON Metadata(json_extract({Column.Metadata.Data}, '$.GPS.\"GPS Longitude\"'));"
            };
            foreach (var sql in expressIdxs)
            {
                using var cmd = connection.CreateCommand();
                cmd.CommandText = sql;
                cmd.ExecuteNonQuery();
            }
        }
        catch { /* Optional optimization */ }

        // Ensure BaseName column exists (Migration for older databases)
        try
        {
            using var command = connection.CreateCommand();
            command.CommandText = $"ALTER TABLE {TableName.FileEntry} ADD COLUMN {Column.FileEntry.BaseName} TEXT;";
            command.ExecuteNonQuery();
        }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 1) { /* Already exists */ }

        // Ensure Hash column exists (Migration)
        try
        {
            using var command = connection.CreateCommand();
            command.CommandText = $"ALTER TABLE {TableName.FileEntry} ADD COLUMN {Column.FileEntry.Hash} TEXT;";
            command.ExecuteNonQuery();
        }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 1) { /* Already exists */ }

        // Ensure Annotation column exists (Migration)
        try
        {
            using var command = connection.CreateCommand();
            command.CommandText = $"ALTER TABLE {TableName.RootPaths} ADD COLUMN {Column.RootPaths.Annotation} TEXT;";
            command.ExecuteNonQuery();
        }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 1) { /* Already exists */ }

        // Ensure Color column exists (Migration)
        try
        {
            using var command = connection.CreateCommand();
            command.CommandText = $"ALTER TABLE {TableName.RootPaths} ADD COLUMN {Column.RootPaths.Color} TEXT;";
            command.ExecuteNonQuery();
        }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 1) { /* Already exists */ }

        // Ensure RecordTouched column exists (Migration)
        try
        {
            using var command = connection.CreateCommand();
            command.CommandText = $"ALTER TABLE {TableName.FileEntry} ADD COLUMN RecordTouched INTEGER DEFAULT 0;";
            command.ExecuteNonQuery();
        }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 1) { /* Already exists */ }

        // Populate BaseName if missing (Migration)
        try
        {
            using (var checkCmd = connection.CreateCommand())
            {
                checkCmd.CommandText = $"SELECT COUNT(*) FROM {TableName.FileEntry} WHERE {Column.FileEntry.BaseName} IS NULL;";
                long nullCount = Convert.ToInt64(checkCmd.ExecuteScalar());
                if (nullCount > 0)
                {
                    _logger?.LogInformation("[DB] Populating BaseName for {Count} entries...", nullCount);
                    var entries = new List<(string Id, string FileName)>();
                    using (var getCmd = connection.CreateCommand())
                    {
                        getCmd.CommandText = $"SELECT {Column.FileEntry.Id}, {Column.FileEntry.FileName} FROM {TableName.FileEntry} WHERE {Column.FileEntry.BaseName} IS NULL;";
                        using var reader = getCmd.ExecuteReader();
                        while (reader.Read()) entries.Add((reader.GetString(0), reader.GetString(1)));
                    }

                    int processed = 0;
                    for (int i = 0; i < entries.Count; i += 1000)
                    {
                        var batch = entries.Skip(i).Take(1000).ToList();
                        using var transaction = connection.BeginTransaction();
                        foreach (var entry in batch)
                        {
                            using var updateCmd = connection.CreateCommand();
                            updateCmd.Transaction = transaction;
                            updateCmd.CommandText = $"UPDATE {TableName.FileEntry} SET {Column.FileEntry.BaseName} = $BaseName WHERE {Column.FileEntry.Id} = $Id;";
                            updateCmd.Parameters.AddWithValue("$BaseName", Path.GetFileNameWithoutExtension(entry.FileName));
                            updateCmd.Parameters.AddWithValue("$Id", entry.Id);
                            updateCmd.ExecuteNonQuery();
                        }
                        transaction.Commit();
                        processed += batch.Count;
                        _logger?.LogInformation("[DB] Populated BaseName for {Count} / {Total} entries...", processed, entries.Count);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "BaseName population failed.");
        }

        NormalizeRoots();
    }

    public void UpdateFileRootId(string fileId, string newRootId)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        ExecuteWrite((connection, transaction) => {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = $"UPDATE {TableName.FileEntry} SET {Column.FileEntry.RootPathId} = $NewId, RecordTouched = $Now WHERE {Column.FileEntry.Id} = $Id";
                command.Parameters.AddWithValue("$NewId", newRootId);
                command.Parameters.AddWithValue("$Now", now);
                command.Parameters.AddWithValue("$Id", fileId);
                command.ExecuteNonQuery();
            }
        });
    }

    public void TouchFile(SqliteConnection connection, SqliteTransaction? transaction, string fileId, long timestamp)
    {
        using (var command = connection.CreateCommand())
        {
            if (transaction != null) command.Transaction = transaction;
            command.CommandText = $"UPDATE {TableName.FileEntry} SET RecordTouched = $Timestamp WHERE {Column.FileEntry.Id} = $Id";
            command.Parameters.AddWithValue("$Timestamp", timestamp);
            command.Parameters.AddWithValue("$Id", fileId);
            command.ExecuteNonQuery();
        }
    }

    public void TouchFileWithRoot(SqliteConnection connection, SqliteTransaction? transaction, string fileId, string newRootId, long timestamp)
    {
        using (var command = connection.CreateCommand())
        {
            if (transaction != null) command.Transaction = transaction;
            command.CommandText = $"UPDATE {TableName.FileEntry} SET {Column.FileEntry.RootPathId} = $NewId, RecordTouched = $Timestamp WHERE {Column.FileEntry.Id} = $Id";
            command.Parameters.AddWithValue("$NewId", newRootId);
            command.Parameters.AddWithValue("$Timestamp", timestamp);
            command.Parameters.AddWithValue("$Id", fileId);
            command.ExecuteNonQuery();
        }
    }

    public List<FileEntry> GetFileEntriesForRoot(string rootId, bool includeTouched = false)
    {
        var result = new List<FileEntry>();
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        using (var command = connection.CreateCommand())
        {
            string touchedFilter = includeTouched ? "" : " AND RecordTouched = 0";
            command.CommandText = $@"
                SELECT {Column.FileEntry.Id}, {Column.FileEntry.FileName}, {Column.FileEntry.Size}, {Column.FileEntry.CreatedAt}, {Column.FileEntry.ModifiedAt}, {Column.FileEntry.RootPathId}
                FROM {TableName.FileEntry} 
                WHERE {Column.FileEntry.RootPathId} = $RootId {touchedFilter}";
            command.Parameters.AddWithValue("$RootId", rootId);

            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                result.Add(new FileEntry {
                    Id = reader.GetString(0),
                    FileName = reader.GetString(1),
                    Size = reader.GetInt64(2),
                    CreatedAt = DateTime.Parse(reader.GetString(3)),
                    ModifiedAt = DateTime.Parse(reader.GetString(4)),
                    RootPathId = reader.GetString(5)
                });
            }
        }
        return result;
    }

    public void NormalizeRoots()
    {
        DeduplicateRoots();
    }

    private void MergeRootsInternal(SqliteConnection connection, SqliteTransaction transaction, string oldId, string newId)
    {
        if (oldId == newId) return;

        // 1. Handle File Conflicts
        var filesInOld = new List<(string id, string name)>();
        using (var getFilesCmd = connection.CreateCommand())
        {
            getFilesCmd.Transaction = transaction;
            getFilesCmd.CommandText = $"SELECT {Column.FileEntry.Id}, {Column.FileEntry.FileName} FROM {TableName.FileEntry} WHERE {Column.FileEntry.RootPathId} = $OldId";
            getFilesCmd.Parameters.AddWithValue("$OldId", oldId);
            using var reader = getFilesCmd.ExecuteReader();
            while (reader.Read()) filesInOld.Add((reader.GetString(0), reader.GetString(1)));
        }

        foreach (var file in filesInOld)
        {
            string? targetFileId = null;
            using (var checkFileCmd = connection.CreateCommand())
            {
                checkFileCmd.Transaction = transaction;
                checkFileCmd.CommandText = $"SELECT {Column.FileEntry.Id} FROM {TableName.FileEntry} WHERE {Column.FileEntry.RootPathId} = $RootId AND {Column.FileEntry.FileName} = $FileName";
                checkFileCmd.Parameters.AddWithValue("$RootId", newId);
                checkFileCmd.Parameters.AddWithValue("$FileName", file.name);
                targetFileId = checkFileCmd.ExecuteScalar() as string;
            }

            if (targetFileId != null)
            {
                // CONFLICT: Merge metadata and delete old entry
                using (var cmd = connection.CreateCommand()) {
                    cmd.Transaction = transaction;
                    cmd.CommandText = $"UPDATE OR IGNORE {TableName.Metadata} SET {Column.Metadata.FileId} = $NewId WHERE {Column.Metadata.FileId} = $OldId";
                    cmd.Parameters.AddWithValue("$NewId", targetFileId);
                    cmd.Parameters.AddWithValue("$OldId", file.id);
                    cmd.ExecuteNonQuery();
                }
                using (var cmd = connection.CreateCommand()) {
                    cmd.Transaction = transaction;
                    cmd.CommandText = $"UPDATE OR IGNORE {TableName.ImagesPicked} SET {Column.ImagesPicked.FileId} = $NewId WHERE {Column.ImagesPicked.FileId} = $OldId";
                    cmd.Parameters.AddWithValue("$NewId", targetFileId);
                    cmd.Parameters.AddWithValue("$OldId", file.id);
                    cmd.ExecuteNonQuery();
                }
                using (var cmd = connection.CreateCommand()) {
                    cmd.Transaction = transaction;
                    cmd.CommandText = $"UPDATE OR IGNORE {TableName.ImageRatings} SET {Column.ImageRatings.FileId} = $NewId WHERE {Column.ImageRatings.FileId} = $OldId";
                    cmd.Parameters.AddWithValue("$NewId", targetFileId);
                    cmd.Parameters.AddWithValue("$OldId", file.id);
                    cmd.ExecuteNonQuery();
                }
                using (var cmd = connection.CreateCommand()) {
                    cmd.Transaction = transaction;
                    cmd.CommandText = $"DELETE FROM {TableName.FileEntry} WHERE {Column.FileEntry.Id} = $Id";
                    cmd.Parameters.AddWithValue("$Id", file.id);
                    cmd.ExecuteNonQuery();
                }
            }
            else
            {
                // NO CONFLICT: Move file to new root
                using (var moveFileCmd = connection.CreateCommand())
                {
                    moveFileCmd.Transaction = transaction;
                    moveFileCmd.CommandText = $"UPDATE {TableName.FileEntry} SET {Column.FileEntry.RootPathId} = $NewId WHERE {Column.FileEntry.Id} = $Id";
                    moveFileCmd.Parameters.AddWithValue("$NewId", newId);
                    moveFileCmd.Parameters.AddWithValue("$Id", file.id);
                    moveFileCmd.ExecuteNonQuery();
                }
            }
        }

        // 2. Handle Folder Conflicts (Recursive Merge)
        var childrenInOld = new List<(string id, string name)>();
        using (var getChildrenCmd = connection.CreateCommand())
        {
            getChildrenCmd.Transaction = transaction;
            getChildrenCmd.CommandText = $"SELECT {Column.RootPaths.Id}, {Column.RootPaths.Name} FROM {TableName.RootPaths} WHERE {Column.RootPaths.ParentId} = $OldId";
            getChildrenCmd.Parameters.AddWithValue("$OldId", oldId);
            using var reader = getChildrenCmd.ExecuteReader();
            while (reader.Read()) childrenInOld.Add((reader.GetString(0), reader.GetString(1)));
        }

        foreach (var child in childrenInOld)
        {
            string? targetChildId = null;
            using (var checkFolderCmd = connection.CreateCommand())
            {
                checkFolderCmd.Transaction = transaction;
                checkFolderCmd.CommandText = $"SELECT {Column.RootPaths.Id} FROM {TableName.RootPaths} WHERE {Column.RootPaths.ParentId} = $ParentId AND {Column.RootPaths.Name} = $Name";
                checkFolderCmd.Parameters.AddWithValue("$ParentId", newId);
                checkFolderCmd.Parameters.AddWithValue("$Name", child.name);
                targetChildId = checkFolderCmd.ExecuteScalar() as string;
            }

            if (targetChildId != null)
            {
                // CONFLICT: Recursively merge sub-folders
                MergeRootsInternal(connection, transaction, child.id, targetChildId);
            }
            else
            {
                // NO CONFLICT: Move sub-folder to new parent
                using (var moveFolderCmd = connection.CreateCommand())
                {
                    moveFolderCmd.Transaction = transaction;
                    moveFolderCmd.CommandText = $"UPDATE {TableName.RootPaths} SET {Column.RootPaths.ParentId} = $NewId WHERE {Column.RootPaths.Id} = $Id";
                    moveFolderCmd.Parameters.AddWithValue("$NewId", newId);
                    moveFolderCmd.Parameters.AddWithValue("$Id", child.id);
                    moveFolderCmd.ExecuteNonQuery();
                }
            }
        }

        // 3. Delete empty old root
        using (var deleteCmd = connection.CreateCommand())
        {
            deleteCmd.Transaction = transaction;
            deleteCmd.CommandText = $"DELETE FROM {TableName.RootPaths} WHERE {Column.RootPaths.Id} = $Id";
            deleteCmd.Parameters.AddWithValue("$Id", oldId);
            deleteCmd.ExecuteNonQuery();
        }
    }

    public string? GetSetting(string? key)
    {
        if (string.IsNullOrEmpty(key)) return null;
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = $"SELECT {Column.Settings.Value} FROM {TableName.Settings} WHERE {Column.Settings.Key} = $Key";
            command.Parameters.AddWithValue("$Key", key);
            return command.ExecuteScalar() as string;
        }
    }

    public void SetSetting(string? key, string? value)
    {
        if (string.IsNullOrEmpty(key)) return;
        ExecuteWrite((connection, transaction) => {
            SetSettingWithConnection(connection, transaction, key, value);
        });
    }

    public void SetSettingWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string? key, string? value)
    {
        if (string.IsNullOrEmpty(key)) return;
        using (var command = connection.CreateCommand())
        {
            if (transaction != null) command.Transaction = transaction;
            command.CommandText = $@"
                INSERT INTO {TableName.Settings} ({Column.Settings.Key}, {Column.Settings.Value}) 
                VALUES ($Key, $Value) 
                ON CONFLICT({Column.Settings.Key}) DO UPDATE SET {Column.Settings.Value} = excluded.{Column.Settings.Value}";
            command.Parameters.AddWithValue("$Key", key);
            command.Parameters.AddWithValue("$Value", value ?? (object)DBNull.Value);
            command.ExecuteNonQuery();
        }
    }

    public LibraryInfoResponse GetLibraryInfo(string previewDbPath, string configPath)
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

        // DB Sizes & Paths
        info.DbPath = connection.DataSource;
        info.DbSize = new FileInfo(connection.DataSource).Length;
        info.PreviewDbPath = previewDbPath;
        info.PreviewDbSize = File.Exists(previewDbPath) ? new FileInfo(previewDbPath).Length : 0;
        info.ConfigPath = configPath;
        
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
        
        if (rootId != null) 
        {
            // Get all descendant IDs
            var descendantIds = GetDescendantRootIds(rootId);
            string idList = string.Join(",", descendantIds.Select(id => $"'{id}'"));
            whereClauses.Add($"f.{Column.FileEntry.RootPathId} IN ({idList})");
        }

        if (specificIds != null && specificIds.Length > 0) 
            whereClauses.Add($"f.{Column.FileEntry.Id} IN ({string.Join(",", specificIds.Select(id => $"'{id}'"))})");

        string where = whereClauses.Count > 0 ? "WHERE " + string.Join(" AND ", whereClauses) : "";

        using (var command = connection.CreateCommand())
        {
            command.CommandText = $@"
                SELECT f.{Column.FileEntry.Id}, f.{Column.FileEntry.RootPathId}, f.{Column.FileEntry.FileName}, f.{Column.FileEntry.Size}, f.{Column.FileEntry.CreatedAt}, f.{Column.FileEntry.ModifiedAt}, f.{Column.FileEntry.Hash},
                       CASE WHEN (SELECT 1 FROM {TableName.ImagesPicked} p WHERE p.{Column.ImagesPicked.FileId} = f.{Column.FileEntry.Id}) IS NOT NULL THEN 1 ELSE 0 END as IsPicked,
                       COALESCE((SELECT r.{Column.ImageRatings.Rating} FROM {TableName.ImageRatings} r WHERE r.{Column.ImageRatings.FileId} = f.{Column.FileEntry.Id}), 0) as Rating,
                       COALESCE(json_extract(s.Value, '$.rotation'), 0) as Rotation,
                       f.{Column.FileEntry.BaseName}
                FROM {TableName.FileEntry} f
                LEFT JOIN {TableName.Settings} s ON s.Key = f.{Column.FileEntry.Hash} || '-pref-img'
                {where}
                ORDER BY f.{Column.FileEntry.CreatedAt} DESC 
                LIMIT $Limit OFFSET $Offset";

            command.Parameters.AddWithValue("$Limit", limit);
            command.Parameters.AddWithValue("$Offset", offset);
            if (rating > 0) command.Parameters.AddWithValue("$Rating", rating);
            // RootId is handled via string interpolation for IN clause

            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                entries.Add(new PhotoResponse {
                    FileEntryId = reader.GetString(0),
                    RootPathId = reader.IsDBNull(1) ? null : reader.GetString(1),
                    FileName = reader.IsDBNull(2) ? null : reader.GetString(2),
                    Size = reader.GetInt64(3),
                    CreatedAt = DateTime.Parse(reader.GetString(4)),
                    ModifiedAt = DateTime.Parse(reader.GetString(5)),
                    Hash = reader.IsDBNull(6) ? null : reader.GetString(6),
                    IsPicked = reader.GetInt32(7) == 1,
                    Rating = reader.GetInt32(8),
                    Rotation = reader.GetInt32(9),
                    StackCount = 1,
                    BaseName = reader.IsDBNull(10) ? null : reader.GetString(10)
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

    public PagedPhotosResponse GetGeotaggedPhotosPaged(int limit, int offset)
    {
        var result = new PagedPhotosResponse();
        var entries = new List<PhotoResponse>();
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        string where = $@"WHERE EXISTS (SELECT 1 FROM {TableName.Metadata} m WHERE m.{Column.Metadata.FileId} = f.{Column.FileEntry.Id} AND json_extract(m.{Column.Metadata.Data}, '$.{MetadataTag.GpsDirectory}.""{MetadataTag.GpsLatitude}""') IS NOT NULL)";

        using (var command = connection.CreateCommand())
        {
            command.CommandText = $@"
                SELECT f.{Column.FileEntry.Id}, f.{Column.FileEntry.RootPathId}, f.{Column.FileEntry.FileName}, f.{Column.FileEntry.Size}, f.{Column.FileEntry.CreatedAt}, f.{Column.FileEntry.ModifiedAt}, f.{Column.FileEntry.Hash},
                       CASE WHEN (SELECT 1 FROM {TableName.ImagesPicked} p WHERE p.{Column.ImagesPicked.FileId} = f.{Column.FileEntry.Id}) IS NOT NULL THEN 1 ELSE 0 END as IsPicked,
                       COALESCE((SELECT r.{Column.ImageRatings.Rating} FROM {TableName.ImageRatings} r WHERE r.{Column.ImageRatings.FileId} = f.{Column.FileEntry.Id}), 0) as Rating,
                       COALESCE(json_extract(s.Value, '$.rotation'), 0) as Rotation,
                       f.{Column.FileEntry.BaseName}
                FROM {TableName.FileEntry} f
                LEFT JOIN {TableName.Settings} s ON s.Key = f.{Column.FileEntry.Hash} || '-pref-img'
                {where}
                ORDER BY f.{Column.FileEntry.CreatedAt} DESC 
                LIMIT $Limit OFFSET $Offset";

            command.Parameters.AddWithValue("$Limit", limit);
            command.Parameters.AddWithValue("$Offset", offset);

            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                entries.Add(new PhotoResponse {
                    FileEntryId = reader.GetString(0),
                    RootPathId = reader.IsDBNull(1) ? null : reader.GetString(1),
                    FileName = reader.IsDBNull(2) ? null : reader.GetString(2),
                    Size = reader.GetInt64(3),
                    CreatedAt = DateTime.Parse(reader.GetString(4)),
                    ModifiedAt = DateTime.Parse(reader.GetString(5)),
                    Hash = reader.IsDBNull(6) ? null : reader.GetString(6),
                    IsPicked = reader.GetInt32(7) == 1,
                    Rating = reader.GetInt32(8),
                    Rotation = reader.GetInt32(9),
                    StackCount = 1,
                    BaseName = reader.IsDBNull(10) ? null : reader.GetString(10)
                });
            }
        }
        result.Photos = entries;
        
        using (var countCmd = connection.CreateCommand())
        {
            countCmd.CommandText = $"SELECT COUNT(*) FROM {TableName.FileEntry} f {where}";
            result.Total = Convert.ToInt32(countCmd.ExecuteScalar());
        }

        return result;
    }

    // --- Collections ---
    public string CreateCollection(string name)
    {
        string id = Guid.NewGuid().ToString();
        ExecuteWrite((connection, transaction) => {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = $"INSERT INTO {TableName.UserCollections} ({Column.UserCollections.Id}, {Column.UserCollections.Name}) VALUES ($Id, $Name)";
                command.Parameters.AddWithValue("$Id", id);
                command.Parameters.AddWithValue("$Name", name);
                command.ExecuteNonQuery();
            }
        });
        return id;
    }

    public void DeleteCollection(string collectionId)
    {
        ExecuteWrite((connection, transaction) => {
            using (var cmd1 = connection.CreateCommand())
            {
                cmd1.Transaction = transaction;
                cmd1.CommandText = $"DELETE FROM {TableName.CollectionFiles} WHERE {Column.CollectionFiles.CollectionId} = $Id";
                cmd1.Parameters.AddWithValue("$Id", collectionId);
                cmd1.ExecuteNonQuery();
            }
            using (var cmd2 = connection.CreateCommand())
            {
                cmd2.Transaction = transaction;
                cmd2.CommandText = $"DELETE FROM {TableName.UserCollections} WHERE {Column.UserCollections.Id} = $Id";
                cmd2.Parameters.AddWithValue("$Id", collectionId);
                cmd2.ExecuteNonQuery();
            }
        });
    }

    public void AddFilesToCollection(string collectionId, IEnumerable<string> fileIds)
    {
        ExecuteWrite((connection, transaction) => {
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
        });
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
            while (reader.Read()) list.Add(new CollectionResponse { CollectionId = reader.GetString(0), Name = reader.GetString(1), Count = reader.GetInt32(2) });
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
        ExecuteWrite((connection, transaction) => {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = $"DELETE FROM {TableName.ImagesPicked}";
                command.ExecuteNonQuery();
            }
        });
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

    public PagedMapPhotoResponse GetMapPhotos()
    {
        var photos = new List<MapPhotoResponse>();
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        using var command = connection.CreateCommand();
        // Query for photos that have GPS metadata
        command.CommandText = $@"
            SELECT f.{Column.FileEntry.Id}, f.{Column.FileEntry.FileName}, f.{Column.FileEntry.CreatedAt},
                   json_extract(m.{Column.Metadata.Data}, '$.{MetadataTag.GpsDirectory}.""{MetadataTag.GpsLatitude}""') as Lat,
                   json_extract(m.{Column.Metadata.Data}, '$.{MetadataTag.GpsDirectory}.""{MetadataTag.GpsLatitudeRef}""') as LatRef,
                   json_extract(m.{Column.Metadata.Data}, '$.{MetadataTag.GpsDirectory}.""{MetadataTag.GpsLongitude}""') as Lng,
                   json_extract(m.{Column.Metadata.Data}, '$.{MetadataTag.GpsDirectory}.""{MetadataTag.GpsLongitudeRef}""') as LngRef
            FROM {TableName.FileEntry} f
            JOIN {TableName.Metadata} m ON f.{Column.FileEntry.Id} = m.{Column.Metadata.FileId}
            WHERE Lat IS NOT NULL AND Lng IS NOT NULL
            ORDER BY f.{Column.FileEntry.CreatedAt} DESC";

        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            string id = reader.GetString(0);
            string fileName = reader.GetString(1);
            DateTime createdAt = DateTime.Parse(reader.GetString(2));
            string latStr = reader.IsDBNull(3) ? "" : reader.GetString(3);
            string latRef = reader.IsDBNull(4) ? "" : reader.GetString(4);
            string lngStr = reader.IsDBNull(5) ? "" : reader.GetString(5);
            string lngRef = reader.IsDBNull(6) ? "" : reader.GetString(6);

            double? lat = ParseGps(latStr, latRef);
            double? lng = ParseGps(lngStr, lngRef);

            if (lat.HasValue && lng.HasValue)
            {
                photos.Add(new MapPhotoResponse
                {
                    FileEntryId = id,
                    FileName = fileName,
                    Latitude = lat.Value,
                    Longitude = lng.Value,
                    CreatedAt = createdAt
                });
            }
        }

        _logger?.LogInformation("[DB] GetMapPhotos: Processed {PhotoCount} photos with valid GPS coordinates.", photos.Count);

        return new PagedMapPhotoResponse { Photos = photos, Total = photos.Count };
    }

    private double? ParseGps(string dms, string refStr)
    {
        try
        {
            // Format is usually: 59° 20' 0.58" or similar
            var matches = System.Text.RegularExpressions.Regex.Matches(dms, @"(\d+(?:\.\d+)?)");
            if (matches.Count < 3) return null;

            double degrees = double.Parse(matches[0].Value);
            double minutes = double.Parse(matches[1].Value);
            double seconds = double.Parse(matches[2].Value);

            double decimalDegrees = degrees + (minutes / 60.0) + (seconds / 3600.0);

            if (refStr == "S" || refStr == "W") decimalDegrees = -decimalDegrees;

            return decimalDegrees;
        }
        catch { return null; }
    }

    // --- Directory Logic ---
    public HashSet<string> GetAllFilePathsForRoot(string rootId)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var subRootIds = GetDescendantRootIds(rootId);

        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        // 1. Build a map of ID -> Absolute Path for all involved roots
        var pathMap = new Dictionary<string, string>();
        foreach (var id in subRootIds)
        {
            string? abs = GetRootAbsolutePath(connection, id);
            if (abs != null) pathMap[id] = abs;
        }

        // 2. Query all files under these roots
        using var command = connection.CreateCommand();
        string idList = string.Join(",", subRootIds.Select(id => $"'{id}'"));
        command.CommandText = $@"
            SELECT {Column.FileEntry.RootPathId}, {Column.FileEntry.FileName} 
            FROM {TableName.FileEntry} 
            WHERE {Column.FileEntry.RootPathId} IN ({idList})";

        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            string rId = reader.GetString(0);
            string name = reader.GetString(1);
            if (pathMap.TryGetValue(rId, out var rootPath))
            {
                result.Add(_pm.Normalize(Path.Combine(rootPath, name)));
            }
        }

        return result;
    }

    public HashSet<string> GetAllIndexedDirectories()
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        var rootIds = new List<string>();
        using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText = $"SELECT {Column.RootPaths.Id} FROM {TableName.RootPaths}";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                rootIds.Add(reader.GetString(0));
            }
        }

        foreach (var id in rootIds)
        {
            string? abs = GetRootAbsolutePath(connection, id);
            if (abs != null) result.Add(_pm.Normalize(abs));
        }

        return result;
    }

    public string? FindClosestRoot(string absolutePath)
    {
        absolutePath = _pm.Normalize(absolutePath);
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        var allRoots = new List<(string id, string path)>();
        using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText = $"SELECT {Column.RootPaths.Id} FROM {TableName.RootPaths}";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                string id = reader.GetString(0);
                string? path = GetRootAbsolutePath(connection, id);
                if (path != null) allRoots.Add((id, path));
            }
        }

        var matchingRoots = allRoots
            .Where(r => absolutePath == r.path || absolutePath.StartsWith(r.path + Path.DirectorySeparatorChar) || absolutePath.StartsWith(r.path + "/"))
            .OrderByDescending(r => r.path.Length)
            .ToList();

        return matchingRoots.FirstOrDefault().id;
    }

    public object? DebugFolder(string rootId)
    {
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        string? name = null;
        string? parentId = null;
        using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText = $"SELECT {Column.RootPaths.Name}, {Column.RootPaths.ParentId} FROM {TableName.RootPaths} WHERE {Column.RootPaths.Id} = $Id";
            cmd.Parameters.AddWithValue("$Id", rootId);
            using var reader = cmd.ExecuteReader();
            if (reader.Read())
            {
                name = reader.GetString(0);
                parentId = reader.IsDBNull(1) ? null : reader.GetString(1);
            }
        }

        string? path = GetRootAbsolutePath(connection, rootId);
        
        int directFiles = 0;
        using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText = $"SELECT COUNT(*) FROM {TableName.FileEntry} WHERE {Column.FileEntry.RootPathId} = $Id";
            cmd.Parameters.AddWithValue("$Id", rootId);
            directFiles = Convert.ToInt32(cmd.ExecuteScalar());
        }

        var children = new List<object>();
        using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText = $"SELECT {Column.RootPaths.Id}, {Column.RootPaths.Name} FROM {TableName.RootPaths} WHERE {Column.RootPaths.ParentId} = $Id";
            cmd.Parameters.AddWithValue("$Id", rootId);
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                children.Add(new { Id = reader.GetString(0), Name = reader.GetString(1) });
            }
        }

        var descendantIds = GetDescendantRootIds(rootId);
        int totalRecursiveFiles = 0;
        if (descendantIds.Count > 0)
        {
            using (var cmd = connection.CreateCommand())
            {
                string idList = string.Join(",", descendantIds.Select(id => $"'{id}'"));
                cmd.CommandText = $"SELECT COUNT(*) FROM {TableName.FileEntry} WHERE {Column.FileEntry.RootPathId} IN ({idList})";
                totalRecursiveFiles = Convert.ToInt32(cmd.ExecuteScalar());
            }
        }

        return new 
        { 
            Id = rootId, 
            Name = name, 
            ParentId = parentId, 
            AbsolutePath = path,
            DirectFiles = directFiles,
            TotalRecursiveFiles = totalRecursiveFiles,
            Children = children,
            DescendantIdsCount = descendantIds.Count
        };
    }

    public object? LocateFile(string fileName)
    {
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        using var command = connection.CreateCommand();
        command.CommandText = $@"
            SELECT f.{Column.FileEntry.Id}, f.{Column.FileEntry.RootPathId}, r.{Column.RootPaths.Name}, f.{Column.FileEntry.RecordTouched}
            FROM {TableName.FileEntry} f
            LEFT JOIN {TableName.RootPaths} r ON f.{Column.FileEntry.RootPathId} = r.{Column.RootPaths.Id}
            WHERE f.{Column.FileEntry.FileName} = $FileName";
        command.Parameters.AddWithValue("$FileName", fileName);

        var results = new List<object>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            string id = reader.GetString(0);
            string rootId = reader.GetString(1);
            string rootName = reader.IsDBNull(2) ? "NULL" : reader.GetString(2);
            int touched = reader.GetInt32(3);
            string? path = GetRootAbsolutePath(connection, rootId);

            results.Add(new { FileId = id, RootId = rootId, RootName = rootName, AbsoluteRootPath = path, RecordTouched = touched });
        }
        return results;
    }

    public int DeduplicateRoots()
    {
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        // 1. Load all root paths and basic stats in one go
        var allNodesRaw = new List<(string Id, string? ParentId, string Name, string? Ann, string? Col, int ImageCount)>();
        using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText = $@"
                SELECT r.{Column.RootPaths.Id}, r.{Column.RootPaths.ParentId}, r.{Column.RootPaths.Name}, r.{Column.RootPaths.Annotation}, r.{Column.RootPaths.Color},
                       (SELECT COUNT(*) FROM {TableName.FileEntry} f WHERE f.{Column.FileEntry.RootPathId} = r.{Column.RootPaths.Id})
                FROM {TableName.RootPaths} r";
            using var reader = cmd.ExecuteReader();
            while (reader.Read()) allNodesRaw.Add((
                reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetInt32(5)
            ));
        }

        if (allNodesRaw.Count == 0) return 0;

        // 2. Build lookups
        var nodeMap = allNodesRaw.ToDictionary(n => n.Id);
        
        string ResolvePath(string id)
        {
            var parts = new List<string>();
            string currentId = id;
            var seen = new HashSet<string>();
            while (nodeMap.TryGetValue(currentId, out var node))
            {
                if (!seen.Add(currentId)) break;
                parts.Add(node.Name);
                if (node.ParentId == null || !nodeMap.ContainsKey(node.ParentId)) break;
                currentId = node.ParentId;
            }
            parts.Reverse();
            if (parts.Count == 0) return string.Empty;
            
            string basePath = parts[0];
            if (parts.Count == 1) return _pm.Normalize(basePath);
            return _pm.Join(basePath, parts.Skip(1));
        }

        // 3. Map every ID to its final normalized physical path
        var resolved = allNodesRaw.Select(n => new { 
            Raw = n, 
            NormPath = ResolvePath(n.Id) 
        }).ToList();

        // 4. Handle Merges (Same physical path)
        var groups = resolved
            .GroupBy(n => n.NormPath)
            .Where(g => g.Count() > 1 && !string.IsNullOrEmpty(g.Key))
            .ToList();

        int totalMerged = 0;
        foreach (var group in groups)
        {
            var winner = group
                .OrderByDescending(n => !string.IsNullOrEmpty(n.Raw.Ann) || !string.IsNullOrEmpty(n.Raw.Col))
                .ThenByDescending(n => n.Raw.ImageCount)
                .ThenBy(n => n.Raw.Id)
                .First();
            
            var losers = group.Where(n => n.Raw.Id != winner.Raw.Id).ToList();
            using var transaction = connection.BeginTransaction();
            try
            {
                foreach (var loser in losers)
                {
                    _logger.LogInformation("[Dedup] Merging duplicate {LoserId} -> {WinnerId} ({Path})", loser.Raw.Id, winner.Raw.Id, loser.NormPath);
                    MergeRootsInternal(connection, transaction, loser.Raw.Id, winner.Raw.Id);
                    totalMerged++;
                }
                transaction.Commit();
            } catch (Exception ex) { _logger.LogError(ex, "Merge failed"); transaction.Rollback(); }
        }

        // 5. Handle Hierarchy Stitching (Adoption)
        // If a base root (ParentId is NULL) is actually inside another root, make it a child.
        var baseRoots = resolved.Where(n => n.Raw.ParentId == null).OrderBy(n => n.NormPath.Length).ToList();
        for (int i = 0; i < baseRoots.Count; i++)
        {
            for (int j = 0; j < baseRoots.Count; j++)
            {
                if (i == j) continue;
                var parent = baseRoots[i];
                var child = baseRoots[j];

                if (child.NormPath.StartsWith(parent.NormPath + Path.DirectorySeparatorChar) || child.NormPath.StartsWith(parent.NormPath + "/"))
                {
                    // Child is physically inside parent. Convert to child hierarchy.
                    _logger.LogInformation("[Stitch] Adopting base root {ChildPath} into {ParentPath}", child.NormPath, parent.NormPath);
                    
                    using var transaction = connection.BeginTransaction();
                    try {
                        // Resolve the relative path to create intermediate folders if needed
                        string expectedId = GetOrCreateHierarchy(connection, transaction, parent.Raw.Id, parent.NormPath, child.NormPath);
                        
                        // If the expectedId is NOT the child.Id, it means we need to merge the child root into the existing hierarchy record
                        if (expectedId != child.Raw.Id) {
                            MergeRootsInternal(connection, transaction, child.Raw.Id, expectedId);
                        }
                        transaction.Commit();
                    } catch (Exception ex) { _logger.LogError(ex, "Stitching failed"); transaction.Rollback(); }
                }
            }
        }

        return totalMerged;
    }

    public string GetOrCreateBaseRoot(string absolutePath)
    {
        string resultId = "";
        ExecuteWrite((connection, transaction) => {
            resultId = GetOrCreateBaseRootWithConnection(connection, transaction, absolutePath);
        });
        return resultId;
    }

    public string GetOrCreateBaseRootWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string absolutePath)
    {
        absolutePath = _pm.Normalize(absolutePath);
        
        // 1. Try to find the deepest existing root that contains this path
        var allRoots = new List<(string id, string path)>();
        var rootIds = new List<string>();
        using (var cmd = connection.CreateCommand())
        {
            if (transaction != null) cmd.Transaction = transaction;
            cmd.CommandText = $"SELECT {Column.RootPaths.Id} FROM {TableName.RootPaths}";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                rootIds.Add(reader.GetString(0));
            }
        }

        foreach (var id in rootIds)
        {
            string? path = GetRootAbsolutePath(connection, id, transaction);
            if (path != null) allRoots.Add((id, path));
        }

        // Sort by path length descending to find the "deepest" match first
        var deepestMatch = allRoots
            .Where(r => absolutePath == r.path || absolutePath.StartsWith(r.path + Path.DirectorySeparatorChar) || absolutePath.StartsWith(r.path + "/"))
            .OrderByDescending(r => r.path.Length)
            .FirstOrDefault();

        if (deepestMatch.id != null)
        {
            if (deepestMatch.path == absolutePath) return deepestMatch.id;

            // It's inside an existing root! Build down.
            var segments = _pm.GetRelativeSegments(deepestMatch.path, absolutePath);
            
            string currentId = deepestMatch.id;
            foreach (var segment in segments)
            {
                currentId = GetOrCreateChildRootWithConnection(connection, transaction, currentId, segment);
            }
            return currentId;
        }

        // 2. No existing parent found, create as new base root
        var result = EnsureRootPathExists(connection, transaction, null, absolutePath);
        if (result.created) _onFolderCreated?.Invoke(result.id, absolutePath);
        return result.id;
    }

    public string GetOrCreateChildRoot(string parentId, string name)
    {
        string resultId = "";
        ExecuteWrite((connection, transaction) => {
            resultId = GetOrCreateChildRootWithConnection(connection, transaction, parentId, name);
        });
        return resultId;
    }

    public string GetOrCreateChildRootWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string parentId, string name)
    {
        var result = EnsureRootPathExists(connection, transaction, parentId, name);
        if (result.created) _onFolderCreated?.Invoke(result.id, name);
        return result.id;
    }

    public string GetOrCreateHierarchy(SqliteConnection connection, SqliteTransaction transaction, string baseRootId, string baseRootPath, string targetDirPath)
    {
        baseRootPath = _pm.Normalize(baseRootPath);
        targetDirPath = _pm.Normalize(targetDirPath);

        if (baseRootPath == targetDirPath) return baseRootId;

        var segments = _pm.GetRelativeSegments(baseRootPath, targetDirPath);
        
        string currentId = baseRootId;
        foreach (var segment in segments)
        {
            currentId = GetOrCreateChildRootWithConnection(connection, transaction, currentId, segment);
        }
        return currentId;
    }

    private (string id, bool created) EnsureRootPathExists(SqliteConnection connection, SqliteTransaction? transaction, string? parentId, string name)
    {
        if (string.IsNullOrWhiteSpace(name)) 
        {
            if (parentId != null) return (parentId, false);
            throw new ArgumentException("Root path name cannot be empty");
        }

        using (var checkCmd = connection.CreateCommand())
        {
            checkCmd.Transaction = transaction;
            if (parentId == null) checkCmd.CommandText = $"SELECT {Column.RootPaths.Id} FROM {TableName.RootPaths} WHERE {Column.RootPaths.ParentId} IS NULL AND {Column.RootPaths.Name} = $Name";
            else { checkCmd.CommandText = $"SELECT {Column.RootPaths.Id} FROM {TableName.RootPaths} WHERE {Column.RootPaths.ParentId} = $ParentId AND {Column.RootPaths.Name} = $Name"; checkCmd.Parameters.AddWithValue("$ParentId", parentId); }
            checkCmd.Parameters.AddWithValue("$Name", name);
            var existingId = checkCmd.ExecuteScalar() as string;
            if (existingId != null) return (existingId, false);
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
                        return (existingBaseId, false); // Technically updated, but effectively 'created' as child? Maybe treated as existing.
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

        return (newId, true);
    }

    public List<string> GetFileIdsUnderRoot(string rootId, bool recursive)
    {
        var ids = new List<string>();
        var targetRootIds = recursive ? GetDescendantRootIds(rootId) : new HashSet<string> { rootId };

        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        foreach (var rId in targetRootIds)
        {
            using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText = $"SELECT {Column.FileEntry.Id} FROM {TableName.FileEntry} WHERE {Column.FileEntry.RootPathId} = $RootId";
                cmd.Parameters.AddWithValue("$RootId", rId);
                using var reader = cmd.ExecuteReader();
                while (reader.Read()) ids.Add(reader.GetString(0));
            }
        }

        _logger?.LogDebug("[DB] GetFileIdsUnderRoot (recursive={Recursive}) found {Count} files", recursive, ids.Count);
        return ids;
    }

    public List<string> GetStackedFileIdsUnderRoot(string rootId, bool recursive)
    {
        var ids = new List<string>();
        var targetRootIds = recursive ? GetDescendantRootIds(rootId) : new HashSet<string> { rootId };
        if (targetRootIds.Count == 0) return ids;

        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        string idList = string.Join(",", targetRootIds.Select(id => $"'{id}'"));
        
        using (var cmd = connection.CreateCommand())
        {
            // Select the 'representative' file for each stack (prioritizing JPG over RAW)
            // This includes solitary files. Solitary RAWs will be filtered out by the 
            // extension filter in the CommunicationLayer.
            cmd.CommandText = $@"
                SELECT Id FROM (
                    SELECT {Column.FileEntry.Id} as Id, {Column.FileEntry.FileName} as FileName,
                           ROW_NUMBER() OVER (
                               PARTITION BY {Column.FileEntry.BaseName} 
                               ORDER BY 
                                   CASE WHEN {Column.FileEntry.FileName} LIKE '%.jpg' OR {Column.FileEntry.FileName} LIKE '%.jpeg' THEN 0 ELSE 1 END,
                                   {Column.FileEntry.FileName} ASC
                           ) as rn
                    FROM {TableName.FileEntry} 
                    WHERE {Column.FileEntry.RootPathId} IN ({idList})
                    AND {Column.FileEntry.BaseName} IS NOT NULL
                )
                WHERE rn = 1";
            
            using var reader = cmd.ExecuteReader();
            while (reader.Read()) ids.Add(reader.GetString(0));
        }

        _logger?.LogDebug("[DB] GetStackedFileIdsUnderRoot (recursive={Recursive}) found {Count} representatives", recursive, ids.Count);
        return ids;
    }

    public HashSet<string> GetDescendantRootIds(string rootId)
    {
        var targetRootIds = new HashSet<string> { rootId };
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        var queue = new Queue<string>();
        queue.Enqueue(rootId);
        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText = $"SELECT {Column.RootPaths.Id} FROM {TableName.RootPaths} WHERE {Column.RootPaths.ParentId} = $ParentId";
                cmd.Parameters.AddWithValue("$ParentId", current);
                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    var childId = reader.GetString(0);
                    if (targetRootIds.Add(childId)) queue.Enqueue(childId);
                }
            }
        }
        return targetRootIds;
    }

    public void UpsertFileEntry(FileEntry entry)
    {
        ExecuteWrite((connection, transaction) => {
            UpsertFileEntryWithConnection(connection, transaction, entry);
        });
    }

    public void UpsertFileEntryWithConnection(SqliteConnection connection, SqliteTransaction? transaction, FileEntry entry)
    {
        bool ownTransaction = false;
        if (transaction == null)
        {
            transaction = connection.BeginTransaction();
            ownTransaction = true;
        }

        try
        {
            string baseName = Path.GetFileNameWithoutExtension(entry.FileName ?? "");
            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = $@"
                    INSERT INTO {TableName.FileEntry} ({Column.FileEntry.Id}, {Column.FileEntry.RootPathId}, {Column.FileEntry.FileName}, {Column.FileEntry.BaseName}, {Column.FileEntry.Size}, {Column.FileEntry.CreatedAt}, {Column.FileEntry.ModifiedAt}, {Column.FileEntry.Hash}, RecordTouched)
                    VALUES ($Id, $RootPathId, $FileName, $BaseName, $Size, $CreatedAt, $ModifiedAt, $Hash, $Now)
                    ON CONFLICT({Column.FileEntry.RootPathId}, {Column.FileEntry.FileName}) DO UPDATE SET 
                        {Column.FileEntry.Size} = excluded.{Column.FileEntry.Size}, 
                        {Column.FileEntry.CreatedAt} = excluded.{Column.FileEntry.CreatedAt}, 
                        {Column.FileEntry.ModifiedAt} = excluded.{Column.FileEntry.ModifiedAt}, 
                        {Column.FileEntry.BaseName} = excluded.{Column.FileEntry.BaseName}, 
                        {Column.FileEntry.Hash} = excluded.{Column.FileEntry.Hash},
                        RecordTouched = $Now;
                ";

                command.Parameters.AddWithValue("$Id", entry.Id);
                command.Parameters.AddWithValue("$RootPathId", entry.RootPathId ?? (object)DBNull.Value);
                command.Parameters.AddWithValue("$FileName", entry.FileName ?? (object)DBNull.Value);
                command.Parameters.AddWithValue("$BaseName", baseName);
                command.Parameters.AddWithValue("$Size", entry.Size);
                command.Parameters.AddWithValue("$CreatedAt", entry.CreatedAt.ToString("o"));
                command.Parameters.AddWithValue("$ModifiedAt", entry.ModifiedAt.ToString("o"));
                command.Parameters.AddWithValue("$Hash", entry.Hash ?? (object)DBNull.Value);
                command.Parameters.AddWithValue("$Now", now);
                command.ExecuteNonQuery();
            }

            // Retrieve the actual ID (in case the conflict resolution updated an existing row with a different ID)
            string? actualId = null;
            using (var getIdCmd = connection.CreateCommand())
            {
                getIdCmd.Transaction = transaction;
                getIdCmd.CommandText = $"SELECT {Column.FileEntry.Id} FROM {TableName.FileEntry} WHERE {Column.FileEntry.RootPathId} = $RootPathId AND {Column.FileEntry.FileName} = $FileName";
                getIdCmd.Parameters.AddWithValue("$RootPathId", entry.RootPathId ?? (object)DBNull.Value);
                getIdCmd.Parameters.AddWithValue("$FileName", entry.FileName ?? (object)DBNull.Value);
                actualId = getIdCmd.ExecuteScalar() as string;
            }

            if (actualId != null)
            {
                using (var deleteCmd = connection.CreateCommand())
                {
                    deleteCmd.Transaction = transaction;
                    deleteCmd.CommandText = $"DELETE FROM {TableName.Metadata} WHERE {Column.Metadata.FileId} = $FileId";
                    deleteCmd.Parameters.AddWithValue("$FileId", actualId);
                    deleteCmd.ExecuteNonQuery();
                }
            }

            if (ownTransaction) transaction.Commit();
        }
        catch (Exception ex)
        {
            if (ownTransaction) transaction.Rollback();
            _logger.LogError(ex, "Error upserting file {FileName}", entry.FileName);
            throw;
        }
    }

    public void DeleteFileEntryWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string fileId)
    {
        using (var cmd1 = connection.CreateCommand())
        {
            if (transaction != null) cmd1.Transaction = transaction;
            cmd1.CommandText = $"DELETE FROM {TableName.Metadata} WHERE {Column.Metadata.FileId} = $Id";
            cmd1.Parameters.AddWithValue("$Id", fileId);
            cmd1.ExecuteNonQuery();
        }
        using (var cmd2 = connection.CreateCommand())
        {
            if (transaction != null) cmd2.Transaction = transaction;
            cmd2.CommandText = $"DELETE FROM {TableName.FileEntry} WHERE {Column.FileEntry.Id} = $Id";
            cmd2.Parameters.AddWithValue("$Id", fileId);
            cmd2.ExecuteNonQuery();
        }
    }

    public string? GetFileHash(string fileId)
    {
        if (_hashCache.TryGetValue(fileId, out string? cached)) return cached;

        using var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return GetFileHashWithConnection(connection, null, fileId);
    }

    public string? GetFileHashWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string fileId)
    {
        if (_hashCache.TryGetValue(fileId, out string? cached)) return cached;

        using var command = connection.CreateCommand();
        if (transaction != null) command.Transaction = transaction;
        command.CommandText = $"SELECT {Column.FileEntry.Hash} FROM {TableName.FileEntry} WHERE {Column.FileEntry.Id} = $Id";
        command.Parameters.AddWithValue("$Id", fileId);
        string? hash = command.ExecuteScalar() as string;
        if (hash != null) _hashCache[fileId] = hash;
        return hash;
    }

    public (string? fullPath, int rotation, bool isHidden) GetExportInfo(string fileId)
    {
        try 
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            
            string? rootId = null;
            string? fileName = null;
            int rotation = 0;
            bool isHidden = false;

            using (var command = connection.CreateCommand())
            {
                command.CommandText = $@"
                    SELECT f.{Column.FileEntry.RootPathId}, f.{Column.FileEntry.FileName}, 
                        COALESCE(json_extract(s.Value, '$.rotation'), 0) as Rotation,
                        EXISTS (SELECT 1 FROM {TableName.Settings} h WHERE h.Key = 'settings.' || f.{Column.FileEntry.RootPathId} AND EXISTS (SELECT 1 FROM json_each(json_extract(h.Value, '$.hidden')) WHERE value = f.{Column.FileEntry.Id})) as IsHidden
                    FROM {TableName.FileEntry} f
                    LEFT JOIN {TableName.Settings} s ON s.Key = f.{Column.FileEntry.Hash} || '-pref-img'
                    WHERE f.{Column.FileEntry.Id} = $Id";
                command.Parameters.AddWithValue("$Id", fileId);
                
                using var reader = command.ExecuteReader();
                if (reader.Read())
                {
                    rootId = reader.GetString(0);
                    fileName = reader.GetString(1);
                    rotation = reader.GetInt32(2);
                    isHidden = reader.GetBoolean(3);
                }
            }

            if (rootId == null || fileName == null) return (null, 0, false);

            var parts = new List<string>();
            string currentId = rootId;
            while (true)
            {
                using var pathCmd = connection.CreateCommand();
                pathCmd.CommandText = $"SELECT {Column.RootPaths.Name}, {Column.RootPaths.ParentId} FROM {TableName.RootPaths} WHERE {Column.RootPaths.Id} = $Id";
                pathCmd.Parameters.AddWithValue("$Id", currentId);
                using var pathReader = pathCmd.ExecuteReader();
                if (!pathReader.Read()) break;

                parts.Add(pathReader.GetString(0));
                if (pathReader.IsDBNull(1)) break;
                currentId = pathReader.GetString(1);
            }

            parts.Reverse();
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
            
            return (fullPath, rotation, isHidden);
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "Error getting export info for {FileId}", fileId);
            return (null, 0, false);
        }
    }

    public string? GetFullFilePath(string fileId)
    {
        return GetExportInfo(fileId).fullPath;
    }

    public string? GetFileRootId(string fileId)
    {
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = $"SELECT {Column.FileEntry.RootPathId} FROM {TableName.FileEntry} WHERE {Column.FileEntry.Id} = $Id";
        command.Parameters.AddWithValue("$Id", fileId);
        return command.ExecuteScalar() as string;
    }

    public string? GetFileId(string rootPathId, string fileName)
    {
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return GetFileIdWithConnection(connection, null, rootPathId, fileName);
    }

    public string? GetFileIdByPath(string absolutePath)
    {
        var rootId = FindClosestRoot(absolutePath);
        if (rootId == null) return null;
        var fileName = Path.GetFileName(absolutePath);
        return GetFileId(rootId, fileName);
    }

    public string? GetFileIdWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string rootPathId, string fileName)
    {
        using (var command = connection.CreateCommand())
        {
            if (transaction != null) command.Transaction = transaction;
            command.CommandText = $"SELECT {Column.FileEntry.Id} FROM {TableName.FileEntry} WHERE {Column.FileEntry.RootPathId} = $RootPathId AND {Column.FileEntry.FileName} = $FileName";
            command.Parameters.AddWithValue("$RootPathId", rootPathId);
            command.Parameters.AddWithValue("$FileName", fileName);
            return command.ExecuteScalar() as string;
        }
    }

    public void UpdateFileHash(string fileId, string hash)
    {
        ExecuteWrite((connection, transaction) => {
            UpdateFileHashWithConnection(connection, transaction, fileId, hash);
        });
    }

    public void UpdateFileHashWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string fileId, string hash)
    {
        _hashCache[fileId] = hash;
        using var command = connection.CreateCommand();
        if (transaction != null) command.Transaction = transaction;
        command.CommandText = $"UPDATE {TableName.FileEntry} SET {Column.FileEntry.Hash} = $Hash WHERE {Column.FileEntry.Id} = $Id";
        command.Parameters.AddWithValue("$Hash", hash);
        command.Parameters.AddWithValue("$Id", fileId);
        command.ExecuteNonQuery();
    }

    public bool FileExistsByHash(string hash)
    {
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return FileExistsByHashWithConnection(connection, null, hash);
    }

    public bool FileExistsByHashWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string hash)
    {
        using var command = connection.CreateCommand();
        if (transaction != null) command.Transaction = transaction;
        command.CommandText = $"SELECT COUNT(*) FROM {TableName.FileEntry} WHERE {Column.FileEntry.Hash} = $Hash";
        command.Parameters.AddWithValue("$Hash", hash);
        return Convert.ToInt32(command.ExecuteScalar()) > 0;
    }

    public (bool exists, DateTime? lastModified) GetExistingFileStatus(string fullPath, SqliteConnection? existingConnection = null)
    {
        fullPath = _pm.Normalize(fullPath);
        var fileName = Path.GetFileName(fullPath);
        var dirPath = Path.GetDirectoryName(fullPath);
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
            var candidates = new List<(string rootPathId, string modifiedStr)>();
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
                    candidates.Add((reader.GetString(0), reader.GetString(1)));
                }
            }

            foreach (var (rootPathId, modStr) in candidates)
            {
                string? candidatePath = GetRootAbsolutePath(connection, rootPathId);
                if (candidatePath != null && candidatePath == dirPath) 
                {
                    if (DateTime.TryParse(modStr, out var mod)) return (true, mod);
                    return (true, null);
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
        fullPath = _pm.Normalize(fullPath);
        var fileName = Path.GetFileName(fullPath);
        var dirPath = Path.GetDirectoryName(fullPath);
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
            var candidates = new List<string>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = $"SELECT {Column.FileEntry.RootPathId} FROM {TableName.FileEntry} WHERE {Column.FileEntry.FileName} = $FileName";
                command.Parameters.AddWithValue("$FileName", fileName);
                
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    candidates.Add(reader.GetString(0));
                }
            }

            foreach (var rootPathId in candidates)
            {
                // 2. Verify path matches for this candidate
                string? candidatePath = GetRootAbsolutePath(connection, rootPathId);
                if (candidatePath != null && candidatePath == dirPath) return true;
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
                _logger.LogWarning("[DB] Cycle detected in RootPaths at ID {Id}!", currentId);
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

        string basePath = parts[0];
        if (parts.Count == 1) return _pm.Normalize(basePath);

        return _pm.Join(basePath, parts.Skip(1));
    }

    public void InsertMetadata(string fileId, IEnumerable<MetadataItem> metadata)
    {
        ExecuteWrite((connection, transaction) => {
            InsertMetadataWithConnection(connection, transaction, fileId, metadata);
        });
    }

    public void InsertMetadataWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string fileId, IEnumerable<MetadataItem> metadata)
    {
        bool ownTransaction = false;
        if (transaction == null)
        {
            transaction = connection.BeginTransaction();
            ownTransaction = true;
        }

        try
        {
            var dict = new Dictionary<string, Dictionary<string, string>>();
            foreach (var item in metadata)
            {
                string dir = item.Directory ?? "General";
                string tag = item.Tag ?? "Unknown";
                string val = item.Value ?? "";
                if (val.Length > 150) val = val.Substring(0, 150);

                if (!dict.ContainsKey(dir)) dict[dir] = new Dictionary<string, string>();
                dict[dir][tag] = val;
            }

            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = $@"
                    INSERT INTO {TableName.Metadata} ({Column.Metadata.FileId}, {Column.Metadata.Data}) 
                    VALUES ($FileId, $Data)
                    ON CONFLICT({Column.Metadata.FileId}) DO UPDATE SET {Column.Metadata.Data} = excluded.{Column.Metadata.Data};";
                command.Parameters.AddWithValue("$FileId", fileId);
                command.Parameters.AddWithValue("$Data", JsonSerializer.Serialize(dict));
                command.ExecuteNonQuery();
            }

            if (ownTransaction) transaction.Commit();
        }
        catch
        {
            if (ownTransaction) transaction.Rollback();
            throw;
        }
    }

    public IEnumerable<DirectoryNodeResponse> GetDirectoryTree()
    {
        var allPaths = new List<(string Id, string? ParentId, string? Name, int ImageCount, int ThumbnailedCount, string? Annotation, string? Color)>();
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        using (var command = connection.CreateCommand())
        {
            string thumbSubquery = $"(SELECT COUNT(*) FROM {TableName.FileEntry} f2 WHERE f2.{Column.FileEntry.RootPathId} = r.{Column.RootPaths.Id} AND f2.{Column.FileEntry.Hash} IS NOT NULL)";

            command.CommandText = $@"
                SELECT r.{Column.RootPaths.Id}, r.{Column.RootPaths.ParentId}, r.{Column.RootPaths.Name},
                       (SELECT COUNT(*) FROM {TableName.FileEntry} f WHERE f.{Column.FileEntry.RootPathId} = r.{Column.RootPaths.Id}),
                       r.{Column.RootPaths.Annotation}, r.{Column.RootPaths.Color},
                       {thumbSubquery}
                FROM {TableName.RootPaths} r";
            using var reader = command.ExecuteReader();
            while (reader.Read()) allPaths.Add((
                reader.GetString(0), 
                reader.IsDBNull(1) ? null : reader.GetString(1), 
                reader.GetString(2),
                reader.GetInt32(3),
                reader.GetInt32(6),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.IsDBNull(5) ? null : reader.GetString(5)
            ));
        }

        var lookup = new Dictionary<string, DirectoryNodeResponse>();
        var roots = new List<DirectoryNodeResponse>();

        foreach (var path in allPaths)
        {
            lookup[path.Id] = new DirectoryNodeResponse {
                DirectoryId = path.Id,
                Name = path.Name ?? "",
                ImageCount = path.ImageCount,
                ThumbnailedCount = path.ThumbnailedCount,
                Annotation = path.Annotation,
                Color = path.Color
            };
        }

        foreach (var path in allPaths)
        {
            var node = lookup[path.Id];
            if (path.ParentId != null && lookup.TryGetValue(path.ParentId, out var parent))
            {
                parent.Children.Add(node);
            }
            else
            {
                roots.Add(node);
            }
        }

        void SetPathsAndSort(DirectoryNodeResponse node, string parentPath)
        {
            if (string.IsNullOrEmpty(parentPath)) node.Path = node.Name;
            else node.Path = Path.Combine(parentPath, node.Name);
            
            var sortedChildren = node.Children.OrderBy(c => c.Name).ToList();
            node.Children.Clear();
            node.Children.AddRange(sortedChildren);

            foreach (var child in node.Children) SetPathsAndSort(child, node.Path);
        }

        var sortedRoots = roots.OrderBy(r => r.Name).ToList();
        foreach (var root in sortedRoots) SetPathsAndSort(root, "");

        // Calculate recursive counts
        void CalculateRecursiveCounts(DirectoryNodeResponse node)
        {
            int total = node.ImageCount;
            int totalThumb = node.ThumbnailedCount;

            foreach (var child in node.Children)
            {
                CalculateRecursiveCounts(child);
                total += child.ImageCount;
                totalThumb += child.ThumbnailedCount;
            }

            node.ImageCount = total;
            node.ThumbnailedCount = totalThumb;
        }

        foreach (var root in sortedRoots) CalculateRecursiveCounts(root);

        return sortedRoots;
    }

    public void SetFolderAnnotation(string folderId, string annotation, string? color = null)
    {
        ExecuteWrite((connection, transaction) => {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                var setClauses = new List<string> { $"{Column.RootPaths.Annotation} = $Annotation" };
                command.Parameters.AddWithValue("$Annotation", annotation);
                if (color != null)
                {
                    setClauses.Add($"{Column.RootPaths.Color} = $Color");
                    command.Parameters.AddWithValue("$Color", color);
                }
                
                command.CommandText = $"UPDATE {TableName.RootPaths} SET {string.Join(", ", setClauses)} WHERE {Column.RootPaths.Id} = $Id";
                command.Parameters.AddWithValue("$Id", folderId);
                command.ExecuteNonQuery();
            }
        });
    }

    public IEnumerable<MetadataItemResponse> GetMetadata(string fileId)
    {
        var items = new List<MetadataItemResponse>();
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = $"SELECT {Column.Metadata.Data} FROM {TableName.Metadata} WHERE {Column.Metadata.FileId} = $FileId";
            command.Parameters.AddWithValue("$FileId", fileId);
            
            string? json = command.ExecuteScalar() as string;
            if (string.IsNullOrEmpty(json)) return items;

            try
            {
                var dict = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string>>>(json);
                if (dict != null)
                {
                    foreach (var dirKvp in dict)
                    {
                        foreach (var tagKvp in dirKvp.Value)
                        {
                            items.Add(new MetadataItemResponse {
                                Directory = dirKvp.Key,
                                Tag = tagKvp.Key,
                                Value = tagKvp.Value
                            });
                        }
                    }
                }
            }
            catch { /* Corrupt JSON? */ }
        }

        // Append view preferences if available
        string? hash = GetFileHash(fileId);
        if (hash == null)
        {
            // Lazy compute hash if missing
            string? fullPath = GetFullFilePath(fileId);
            if (fullPath != null && File.Exists(fullPath))
            {
                try 
                {
                    using (var stream = File.Open(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        var hasher = new XxHash64();
                        hasher.Append(stream);
                        hash = Convert.ToHexString(hasher.GetCurrentHash()).ToLowerInvariant();
                    }
                    
                    // Save back to DB using the lock
                    string fixedHash = hash;
                    ExecuteWrite((conn, trans) => {
                        UpdateFileHashWithConnection(conn, trans, fileId, fixedHash);
                    });
                }
                catch (Exception ex) { _logger.LogError(ex, "Failed to lazy-compute hash for {FileId}", fileId); }
            }
        }

        if (hash != null)
        {
            // Send hash to client so it can update its model for saving future prefs
            items.Add(new MetadataItemResponse { Directory = "Internal", Tag = "FileHash", Value = hash });

            string key = $"{hash}-pref-img";
            string? prefs = GetSetting(key);
            if (prefs != null)
            {
                items.Add(new MetadataItemResponse { Directory = "Application", Tag = "ViewPreferences", Value = prefs });
            }
        }

        return items;
    }

    public void SetPicked(string fileId, bool isPicked)
    {
        ExecuteWrite((connection, transaction) => {
            SetPickedWithConnection(connection, transaction, fileId, isPicked);
        });
    }

    public void SetPickedWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string fileId, bool isPicked)
    {
        using (var command = connection.CreateCommand())
        {
            if (transaction != null) command.Transaction = transaction;
            if (isPicked) command.CommandText = $"INSERT OR IGNORE INTO {TableName.ImagesPicked} ({Column.ImagesPicked.FileId}) VALUES ($Id)";
            else command.CommandText = $"DELETE FROM {TableName.ImagesPicked} WHERE {Column.ImagesPicked.FileId} = $Id";
            command.Parameters.AddWithValue("$Id", fileId);
            command.ExecuteNonQuery();
        }
    }

    public void SetRating(string fileId, int rating)
    {
        ExecuteWrite((connection, transaction) => {
            SetRatingWithConnection(connection, transaction, fileId, rating);
        });
    }

    public void SetRatingWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string fileId, int rating)
    {
        using (var command = connection.CreateCommand())
        {
            if (transaction != null) command.Transaction = transaction;
            if (rating > 0) {
                command.CommandText = $@"INSERT INTO {TableName.ImageRatings} ({Column.ImageRatings.FileId}, {Column.ImageRatings.Rating}) VALUES ($Id, $Rating) ON CONFLICT({Column.ImageRatings.FileId}) DO UPDATE SET {Column.ImageRatings.Rating} = excluded.{Column.ImageRatings.Rating}";
                command.Parameters.AddWithValue("$Rating", rating);
            } else command.CommandText = $"DELETE FROM {TableName.ImageRatings} WHERE {Column.ImageRatings.FileId} = $Id";
            command.Parameters.AddWithValue("$Id", fileId);
            command.ExecuteNonQuery();
        }
    }

    // REQ-SVC-00012
    public IEnumerable<string> Search(SearchRequest req)
    {
        var ids = new List<string>();
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        using (var command = connection.CreateCommand())
        {
            if (!string.IsNullOrEmpty(req.query))
            {
                string q = req.query.Trim();
                
                // Regex for size comparison: size (>|<) (\d+)(kb|mb|gb)?
                var sizeMatch = System.Text.RegularExpressions.Regex.Match(q, @"^size\s*([><])\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb|b)?", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (sizeMatch.Success)
                {
                    string op = sizeMatch.Groups[1].Value;
                    double val = double.Parse(sizeMatch.Groups[2].Value);
                    string unit = sizeMatch.Groups[3].Value.ToLower();
                    long bytes = (long)val;
                    if (unit == "kb") bytes = (long)(val * 1024);
                    else if (unit == "mb") bytes = (long)(val * 1024 * 1024);
                    else if (unit == "gb") bytes = (long)(val * 1024 * 1024 * 1024);

                    command.CommandText = $"SELECT {Column.FileEntry.Id} FROM {TableName.FileEntry} WHERE {Column.FileEntry.Size} {(op == ">" ? ">" : "<")} $Size";
                    command.Parameters.AddWithValue("$Size", bytes);
                }
                // Regex for tag: tag:NAME [= VALUE]
                else if (q.StartsWith("tag:", StringComparison.OrdinalIgnoreCase))
                {
                    string sub = q.Substring(4).Trim();
                    if (sub.Contains("="))
                    {
                        string[] parts = sub.Split('=', 2);
                        command.CommandText = $@"
                            SELECT DISTINCT {Column.Metadata.FileId} 
                            FROM {TableName.Metadata}, json_each({TableName.Metadata}.{Column.Metadata.Data}) as d, json_each(d.value) as t 
                            WHERE t.key LIKE $Tag AND t.value LIKE $Value";
                        command.Parameters.AddWithValue("$Tag", "%" + parts[0].Trim() + "%");
                        command.Parameters.AddWithValue("$Value", "%" + parts[1].Trim() + "%");
                    }
                    else
                    {
                        command.CommandText = $@"
                            SELECT DISTINCT {Column.Metadata.FileId} 
                            FROM {TableName.Metadata}, json_each({TableName.Metadata}.{Column.Metadata.Data}) as d, json_each(d.value) as t 
                            WHERE t.key LIKE $Tag";
                        command.Parameters.AddWithValue("$Tag", "%" + sub + "%");
                    }
                }
                // Path search (filename or folder segments)
                else if (q.StartsWith("path:", StringComparison.OrdinalIgnoreCase))
                {
                    string sub = q.Substring(5).Trim();
                    command.CommandText = $@"
                        SELECT f.{Column.FileEntry.Id} 
                        FROM {TableName.FileEntry} f
                        JOIN {TableName.RootPaths} r ON f.{Column.FileEntry.RootPathId} = r.{Column.RootPaths.Id}
                        WHERE f.{Column.FileEntry.FileName} LIKE $Query OR r.{Column.RootPaths.Name} LIKE $Query";
                    command.Parameters.AddWithValue("$Query", "%" + sub + "%");
                }
                // Global fallback search
                else
                {
                    command.CommandText = $@"
                        SELECT DISTINCT f.{Column.FileEntry.Id} 
                        FROM {TableName.FileEntry} f
                        JOIN {TableName.RootPaths} r ON f.{Column.FileEntry.RootPathId} = r.{Column.RootPaths.Id}
                        LEFT JOIN {TableName.Metadata} m ON f.{Column.FileEntry.Id} = m.{Column.Metadata.FileId}
                        WHERE f.{Column.FileEntry.FileName} LIKE $Query 
                           OR r.{Column.RootPaths.Name} LIKE $Query
                           OR EXISTS (SELECT 1 FROM json_tree(m.{Column.Metadata.Data}) WHERE value LIKE $Query)";
                    command.Parameters.AddWithValue("$Query", "%" + q + "%");
                }
            }
            else if (!string.IsNullOrEmpty(req.tag))
            {
                command.CommandText = $@"
                    SELECT DISTINCT {Column.Metadata.FileId} 
                    FROM {TableName.Metadata}, json_each({TableName.Metadata}.{Column.Metadata.Data}) as d, json_each(d.value) as t 
                    WHERE t.key = $Tag AND t.value = $Value";
                command.Parameters.AddWithValue("$Tag", req.tag);
                command.Parameters.AddWithValue("$Value", req.value ?? "");
            }
            else
            {
                return Enumerable.Empty<string>();
            }

            using var reader = command.ExecuteReader();
            while (reader.Read()) ids.Add(reader.GetString(0));
        }
        return ids;
    }

    public HashSet<string> GetExistingFileNames(string rootId, IEnumerable<string> fileNames)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (fileNames == null || !fileNames.Any()) return result;

        var targetRootIds = new HashSet<string> { rootId };
        
        using var connection = GetOpenConnection();

        // Collect all recursive root IDs
        var queue = new Queue<string>();
        queue.Enqueue(rootId);
        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText = $"SELECT {Column.RootPaths.Id} FROM {TableName.RootPaths} WHERE {Column.RootPaths.ParentId} = $ParentId";
                cmd.Parameters.AddWithValue("$ParentId", current);
                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    var childId = reader.GetString(0);
                    if (targetRootIds.Add(childId)) queue.Enqueue(childId);
                }
            }
        }

        var nameList = fileNames.Distinct().ToList();
        int batchSize = 200;

        if (targetRootIds.Count > 100)
        {
            using (var tCmd = connection.CreateCommand())
            {
                tCmd.CommandText = $"CREATE TEMP TABLE IF NOT EXISTS {TableName.TempRoots} (Id TEXT PRIMARY KEY)";
                tCmd.ExecuteNonQuery();
            }
            using (var tCmd = connection.CreateCommand())
            {
                tCmd.CommandText = $"DELETE FROM {TableName.TempRoots}";
                tCmd.ExecuteNonQuery();
            }
            using (var transaction = connection.BeginTransaction())
            {
                foreach(var r in targetRootIds)
                {
                    using var ins = connection.CreateCommand();
                    ins.Transaction = transaction;
                    ins.CommandText = $"INSERT OR IGNORE INTO {TableName.TempRoots} (Id) VALUES (@id)";
                    ins.Parameters.AddWithValue("@id", r);
                    ins.ExecuteNonQuery();
                }
                transaction.Commit();
            }
        }

        for (int i = 0; i < nameList.Count; i += batchSize)
        {
            var batch = nameList.Skip(i).Take(batchSize).ToList();
            using (var cmd = connection.CreateCommand())
            {
                var nameParams = new List<string>();
                for (int j = 0; j < batch.Count; j++)
                {
                    string p = $"@n{j}";
                    nameParams.Add(p);
                    cmd.Parameters.AddWithValue(p, batch[j]);
                }

                if (targetRootIds.Count > 100)
                {
                    cmd.CommandText = $@"
                        SELECT {Column.FileEntry.FileName} 
                        FROM {TableName.FileEntry} 
                        WHERE {Column.FileEntry.RootPathId} IN (SELECT Id FROM {TableName.TempRoots}) 
                        AND {Column.FileEntry.FileName} IN ({string.Join(",", nameParams)})";
                }
                else
                {
                    string rootIn = string.Join(",", targetRootIds.Select(r => $"'{r}'")); 
                    cmd.CommandText = $@"
                        SELECT {Column.FileEntry.FileName} 
                        FROM {TableName.FileEntry} 
                        WHERE {Column.FileEntry.RootPathId} IN ({rootIn}) 
                        AND {Column.FileEntry.FileName} IN ({string.Join(",", nameParams)})";
                }
                        
                using var reader = cmd.ExecuteReader();
                while (reader.Read()) result.Add(reader.GetString(0));
            }
        }

        return result;
    }

    public List<string> GetFileHashesUnderRoot(string rootId)
    {
        var hashes = new List<string>();
        using var connection = GetOpenConnection();
        var rootIds = GetRecursiveRootIds(connection, rootId);
        string rootIdList = string.Join(",", rootIds.Select(id => $"'{id}'"));

        using var command = connection.CreateCommand();
        command.CommandText = $@"
            SELECT DISTINCT {Column.FileEntry.Hash} 
            FROM {TableName.FileEntry} 
            WHERE {Column.FileEntry.RootPathId} IN ({rootIdList}) 
            AND {Column.FileEntry.Hash} IS NOT NULL";
        
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            hashes.Add(reader.GetString(0));
        }
        return hashes;
    }

    public void ForgetRoot(string rootId)
    {
        ExecuteWrite((connection, transaction) => {
            var rootIds = GetRecursiveRootIds(connection, rootId);
            string rootIdList = string.Join(",", rootIds.Select(id => $"'{id}'"));

            // 1. Delete Metadata
            using (var cmd = connection.CreateCommand())
            {
                cmd.Transaction = transaction;
                cmd.CommandText = $@"
                    DELETE FROM {TableName.Metadata} 
                    WHERE {Column.Metadata.FileId} IN (
                        SELECT {Column.FileEntry.Id} 
                        FROM {TableName.FileEntry} 
                        WHERE {Column.FileEntry.RootPathId} IN ({rootIdList})
                    )";
                cmd.ExecuteNonQuery();
            }

            // 2. Delete Picked status
            using (var cmd = connection.CreateCommand())
            {
                cmd.Transaction = transaction;
                cmd.CommandText = $@"
                    DELETE FROM {TableName.ImagesPicked} 
                    WHERE {Column.ImagesPicked.FileId} IN (
                        SELECT {Column.FileEntry.Id} 
                        FROM {TableName.FileEntry} 
                        WHERE {Column.FileEntry.RootPathId} IN ({rootIdList})
                    )";
                cmd.ExecuteNonQuery();
            }

            // 3. Delete Rating status
            using (var cmd = connection.CreateCommand())
            {
                cmd.Transaction = transaction;
                cmd.CommandText = $@"
                    DELETE FROM {TableName.ImageRatings} 
                    WHERE {Column.ImageRatings.FileId} IN (
                        SELECT {Column.FileEntry.Id} 
                        FROM {TableName.FileEntry} 
                        WHERE {Column.FileEntry.RootPathId} IN ({rootIdList})
                    )";
                cmd.ExecuteNonQuery();
            }

            // 4. Delete Collection mappings
            using (var cmd = connection.CreateCommand())
            {
                cmd.Transaction = transaction;
                cmd.CommandText = $@"
                    DELETE FROM {TableName.CollectionFiles} 
                    WHERE {Column.CollectionFiles.FileId} IN (
                        SELECT {Column.FileEntry.Id} 
                        FROM {TableName.FileEntry} 
                        WHERE {Column.FileEntry.RootPathId} IN ({rootIdList})
                    )";
                cmd.ExecuteNonQuery();
            }

            // 5. Delete Files
            using (var cmd = connection.CreateCommand())
            {
                cmd.Transaction = transaction;
                cmd.CommandText = $@"
                    DELETE FROM {TableName.FileEntry} 
                    WHERE {Column.FileEntry.RootPathId} IN ({rootIdList})";
                cmd.ExecuteNonQuery();
            }

            // 6. Delete Roots
            using (var cmd = connection.CreateCommand())
            {
                cmd.Transaction = transaction;
                cmd.CommandText = $@"
                    DELETE FROM {TableName.RootPaths} 
                    WHERE {Column.RootPaths.Id} IN ({rootIdList})";
                cmd.ExecuteNonQuery();
            }
            _logger.LogInformation("Forgot root {RootId} and its {Count} sub-roots.", rootId, rootIds.Count);
        });
    }

    private List<string> GetRecursiveRootIds(SqliteConnection connection, string rootId)
    {
        var result = new List<string> { rootId };
        var queue = new Queue<string>();
        queue.Enqueue(rootId);

        while (queue.Count > 0)
        {
            var currentId = queue.Dequeue();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $@"
                SELECT {Column.RootPaths.Id} 
                FROM {TableName.RootPaths} 
                WHERE {Column.RootPaths.ParentId} = $ParentId";
            cmd.Parameters.AddWithValue("$ParentId", currentId);
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var childId = reader.GetString(0);
                result.Add(childId);
                queue.Enqueue(childId);
            }
        }
        return result;
    }
}