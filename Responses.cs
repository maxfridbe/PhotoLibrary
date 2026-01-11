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
        public bool IsPicked { get; set; }
        public int Rating { get; set; }
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

    public class RootPathResponse
    {
        public string Id { get; set; } = "";
        public string? ParentId { get; set; }
        public string? Name { get; set; }
    }

    public class CollectionResponse
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public int Count { get; set; }
    }

    public class StatsResponse
    {
        public int PickedCount { get; set; }
        public int[] RatingCounts { get; set; } = new int[5];
    }
}
