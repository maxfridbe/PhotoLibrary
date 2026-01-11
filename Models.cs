using System;

namespace PhotoLibrary
{
    public class FileEntry
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string? RootPath { get; set; }
        public string? FileName { get; set; }
        public string? RelativePath { get; set; }
        public string? FullPath { get; set; }
        public long Size { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime ModifiedAt { get; set; }
    }

    public class MetadataItem
    {
        public string? Directory { get; set; }
        public string? Tag { get; set; }
        public string? Value { get; set; }
    }
}
