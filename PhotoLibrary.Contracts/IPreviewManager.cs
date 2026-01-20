using System;

namespace PhotoLibrary.Backend;

public interface IPreviewManager
{
    string DbPath { get; }
    void Initialize();
    bool HasPreview(string hash, int longEdge);
    void SavePreview(string hash, int longEdge, byte[] data);
    byte[]? GetPreviewData(string hash, int longEdge);
    void DeletePreviewsByHash(string hash);
    int GetTotalUniqueHashes();
}
