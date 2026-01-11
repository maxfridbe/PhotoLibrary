using System;

namespace PhotoLibrary
{
    public class FileEntry
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string? DirectoryId { get; set; }
        public string? FileName { get; set; }
        // RelativePath might still be useful for display, but user focused on FullPath removal/normalization.
        // We'll keep RelativePath as a convenient field for now, or remove if strictly normalizing.
        // The user said "dont store fullpath". I'll keep RelativePath as it's not FullPath.
        public string? RelativePath { get; set; } 
        public long Size { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime ModifiedAt { get; set; }
    }

    public class DirectoryEntry
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string? ParentId { get; set; }
        public string? Name { get; set; }
    }

    public class MetadataItem
    {
        public string? Directory { get; set; }
        public string? Tag { get; set; }
        public string? Value { get; set; }
    }
}