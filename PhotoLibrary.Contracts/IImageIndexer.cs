using System;
using System.IO;

namespace PhotoLibrary.Backend;

public interface IImageIndexer
{
    event Action<string, string>? OnFileProcessed;
    void Scan(string directoryPath, bool testOne = false, int? limit = null);
    void ProcessSingleFile(FileInfo file, string scanRootPath);
    ThumbnailResult EnsureThumbnails(string fileId);
    void GeneratePreviews(FileInfo file, string fileId);
}