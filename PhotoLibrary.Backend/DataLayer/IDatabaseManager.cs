using System;
using System.Collections.Generic;
using Microsoft.Data.Sqlite;

namespace PhotoLibrary.Backend;

public interface IDatabaseManager
{
    string DbPath { get; }
    void RegisterFolderCreatedHandler(Action<string, string> handler);

    void ClearCaches();
    SqliteConnection GetOpenConnection();
    void Initialize();
    void NormalizeRoots();
    string? GetSetting(string? key);
    void SetSetting(string? key, string? value);
    LibraryInfoResponse GetLibraryInfo(string previewDbPath, string configPath);
    StatsResponse GetGlobalStats();
    PagedPhotosResponse GetPhotosPaged(int limit, int offset, string? rootId = null, bool pickedOnly = false, int rating = 0, string[]? specificIds = null);
    string CreateCollection(string name);
    void DeleteCollection(string collectionId);
    void AddFilesToCollection(string collectionId, IEnumerable<string> fileIds);
    IEnumerable<CollectionResponse> GetCollections();
    IEnumerable<string> GetCollectionFiles(string collectionId);
    void ClearPicked();
    IEnumerable<string> GetPickedIds();
    string GetOrCreateBaseRoot(string absolutePath);
    string GetOrCreateChildRoot(string parentId, string name);
    List<string> GetFileIdsUnderRoot(string rootId, bool recursive);
    void UpsertFileEntry(FileEntry entry);
    void UpsertFileEntryWithConnection(SqliteConnection connection, SqliteTransaction? transaction, FileEntry entry);
    string? GetFileHash(string fileId);
    (string? fullPath, int rotation, bool isHidden) GetExportInfo(string fileId);
    string? GetFullFilePath(string fileId);
    string? GetFileRootId(string fileId);
    string? GetFileId(string rootPathId, string fileName);
    string? GetFileIdWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string rootPathId, string fileName);
    void UpdateFileHash(string fileId, string hash);
    bool FileExistsByHash(string hash);
    (bool exists, DateTime? lastModified) GetExistingFileStatus(string fullPath, SqliteConnection? existingConnection = null);
    bool FileExists(string fullPath, SqliteConnection? existingConnection = null);
    void InsertMetadata(string fileId, IEnumerable<MetadataItem> metadata);
    void InsertMetadataWithConnection(SqliteConnection connection, SqliteTransaction? transaction, string fileId, IEnumerable<MetadataItem> metadata);
    IEnumerable<DirectoryNodeResponse> GetDirectoryTree();
    void SetFolderAnnotation(string folderId, string annotation, string? color = null);
    void ForgetRoot(string rootId);
    List<string> GetFileHashesUnderRoot(string rootId);
    IEnumerable<MetadataItemResponse> GetMetadata(string fileId);
    void SetPicked(string fileId, bool isPicked);
    void SetRating(string fileId, int rating);
    IEnumerable<string> Search(SearchRequest req);
    HashSet<string> GetExistingFileNames(string rootId, IEnumerable<string> fileNames);
}