using System;
using System.Collections.Generic;

namespace PhotoLibrary.Backend;

public record PhotoResponse
{
    public string FileEntryId { get; init; } = "";
    public string? RootPathId { get; init; }
    public string? FileName { get; init; }
    public string? BaseName { get; init; }
    public long Size { get; init; }
    public DateTime CreatedAt { get; init; }
    public DateTime ModifiedAt { get; init; }
    public string? Hash { get; init; }
    public bool IsPicked { get; init; }
    public int Rating { get; init; }
    public int Rotation { get; init; }
    public int StackCount { get; init; }
    public string? StackExtensions { get; init; }
    public List<string> StackFileIds { get; init; } = new();
}

public record PagedPhotosResponse
{
    public IEnumerable<PhotoResponse> Photos { get; set; } = new List<PhotoResponse>();
    public int Total { get; set; }
}

public record MetadataItemResponse
{
    public string? Directory { get; init; }
    public string? Tag { get; init; }
    public string? Value { get; init; }
}

public record MetadataGroupResponse
{
    public string Name { get; init; } = "";
    public Dictionary<string, string> Items { get; init; } = new();
}

public record DirectoryNodeResponse
{
    public string DirectoryId { get; init; } = "";
    public string Name { get; init; } = "";
    public string Path { get; set; } = "";
    public int ImageCount { get; set; }
    public int ThumbnailedCount { get; set; }
    public string? Annotation { get; init; }
    public string? Color { get; init; }
    public List<DirectoryNodeResponse> Children { get; init; } = new();
}

public record CollectionResponse
{
    public string CollectionId { get; init; } = "";
    public string Name { get; init; } = "";
    public int Count { get; init; }
}

public record CollectionCreatedResponse(string collectionId, string name);

public record StatsResponse
{
    public int TotalCount { get; set; }
    public int PickedCount { get; set; }
    public int[] RatingCounts { get; set; } = new int[5];
}

public record LibraryInfoResponse
{
    public int TotalImages { get; set; }
    public long DbSize { get; set; }
    public long PreviewDbSize { get; set; }
    public string DbPath { get; set; } = "";
    public string PreviewDbPath { get; set; } = "";
    public string ConfigPath { get; set; } = "";
    public bool IsIndexing { get; set; }
    public int IndexedCount { get; set; }
    public int TotalToIndex { get; set; }
    public int TotalThumbnailedImages { get; set; }
    public List<BackupFileResponse> Backups { get; set; } = new();
}

public record BackupFileResponse
{
    public string Name { get; init; } = "";
    public DateTime Date { get; init; }
    public long Size { get; init; }
}

public record DirectoryResponse

{

    public string Path { get; init; } = "";

    public string Name { get; init; } = "";

}



public record ApplicationSettingsResponse

{

    public string RuntimeMode { get; init; } = "WebHost";

    public string Version { get; init; } = "";

}

public record ScanFileResult
{
    public string Path { get; init; } = "";
    public DateTime DateTaken { get; init; }
}

public record ValidateImportResponse
{
    public List<string> ExistingSourceFiles { get; init; } = new();
}
