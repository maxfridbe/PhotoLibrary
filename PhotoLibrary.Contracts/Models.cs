using System;

namespace PhotoLibrary.Backend;

public class FileEntry
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string RootPathId { get; set; } = "";
    public string? FileName { get; set; }
    public string? BaseName { get; set; }
    public long Size { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime ModifiedAt { get; set; }
    public string? Hash { get; set; }
}

public class MetadataItem
{
    public string? Directory { get; set; }
    public string? Tag { get; set; }
    public string? Value { get; set; }
}

public record GeneratedPreview(int Size, byte[] Data);

public record ProcessedFileData(FileEntry Entry, List<MetadataItem> Metadata, List<GeneratedPreview> Previews);