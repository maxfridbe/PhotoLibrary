using System;
using System.IO;
using System.Data.Common;

namespace PhotoLibrary.Backend;

public interface IImageIndexer
{
    void RegisterFileProcessedHandler(Action<string, string> handler);
    void Scan(string directoryPath, bool testOne = false, int? limit = null);
    void ProcessSingleFile(FileInfo file, string scanRootPath);
    void ProcessSingleFileFromSource(FileInfo sourceFile, string targetPath, string scanRootPath, string? hash = null);
    ProcessedFileData PrepareFileData(FileInfo sourceFile, string targetPath, string targetRootId, string? providedHash = null, bool forceHash = false);
    void CommitFileDataWithConnection(DbConnection connection, DbTransaction? transaction, ProcessedFileData data, string targetPath, string scanRootPath, string scanRootId);
    ThumbnailResult EnsureThumbnails(string fileEntryId);
    void GeneratePreviews(FileInfo file, string fileEntryId);
}