using System;
using System.Collections.Generic;

namespace PhotoLibrary
{
    public class PhotoResponse
    {
        public string Id { get; set; } = "";
        public string? RootPathId { get; set; }
        public string? FileName { get; set; }
        public long Size { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime ModifiedAt { get; set; }
        public string? Hash { get; set; }
        public bool IsPicked { get; set; }
        public int Rating { get; set; }
        public int Rotation { get; set; }
        public int StackCount { get; set; }
        public string? StackExtensions { get; set; }
        public List<string> StackFileIds { get; set; } = new();
    }

    public class PagedPhotosResponse
    {
        public IEnumerable<PhotoResponse> Photos { get; set; } = new List<PhotoResponse>();
        public int Total { get; set; }
    }

    public class MetadataItemResponse
    {
        public string? Directory { get; set; }
        public string? Tag { get; set; }
        public string? Value { get; set; }
    }

    public class MetadataGroupResponse
    {
        public string Name { get; set; } = "";
        public Dictionary<string, string> Items { get; set; } = new();
    }

    public class DirectoryNodeResponse
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Path { get; set; } = "";
        public int ImageCount { get; set; }
        public int ThumbnailedCount { get; set; }
        public string? Annotation { get; set; }
        public string? Color { get; set; }
        public List<DirectoryNodeResponse> Children { get; set; } = new();
    }

    public class CollectionResponse
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public int Count { get; set; }
    }

    public class StatsResponse
    {
        public int TotalCount { get; set; }
        public int PickedCount { get; set; }
        public int[] RatingCounts { get; set; } = new int[5];
    }

    public class LibraryInfoResponse
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
    }

    public class DirectoryResponse
    {
        public string Path { get; set; } = "";
        public string Name { get; set; } = "";
    }
}
