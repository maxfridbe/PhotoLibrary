using System;
using System.IO;

namespace PhotoLibrary.Backend;

public interface IImageIndexer
{
    void RegisterFileProcessedHandler(Action<string, string> handler);
    void Scan(string directoryPath, bool testOne = false, int? limit = null);
    void ProcessSingleFile(FileInfo file, string scanRootPath);
    void ProcessSingleFileFromSource(FileInfo sourceFile, string targetPath, string scanRootPath, string? hash = null);
    ThumbnailResult EnsureThumbnails(string fileEntryId);
    void GeneratePreviews(FileInfo file, string fileEntryId);
}