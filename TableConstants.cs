namespace PhotoLibrary
{
    public static class TableConstants
    {
        public static class TableName
        {
            public const string RootPaths = "RootPaths";
            public const string FileEntry = "FileEntry";
            public const string Metadata = "Metadata";
            public const string ImagesPicked = "images_picked";
            public const string ImageRatings = "ImageRatings";
            public const string UserCollections = "UserCollections";
            public const string CollectionFiles = "CollectionFiles";
            public const string Previews = "Previews";
        }

        public static class Column
        {
            public static class RootPaths
            {
                public const string Id = "Id";
                public const string ParentId = "ParentId";
                public const string Name = "Name";
                public const string Annotation = "Annotation";
                public const string Color = "Color";
            }
            public static class FileEntry
            {
                public const string Id = "Id";
                public const string RootPathId = "RootPathId";
                public const string FileName = "FileName";
                public const string BaseName = "BaseName";
                public const string Size = "Size";
                public const string CreatedAt = "CreatedAt";
                public const string ModifiedAt = "ModifiedAt";
                public const string Hash = "Hash";
            }
            public static class Metadata
            {
                public const string FileId = "FileId";
                public const string Directory = "Directory";
                public const string Tag = "Tag";
                public const string Value = "Value";
            }
            public static class ImagesPicked
            {
                public const string FileId = "FileId";
                public const string PickedAt = "PickedAt";
            }
            public static class ImageRatings
            {
                public const string FileId = "FileId";
                public const string Rating = "Rating";
            }
            public static class UserCollections
            {
                public const string Id = "Id";
                public const string Name = "Name";
            }
            public static class CollectionFiles
            {
                public const string CollectionId = "CollectionId";
                public const string FileId = "FileId";
            }
            public static class Previews
            {
                public const string FileId = "FileId";
                public const string Hash = "Hash";
                public const string LongEdge = "LongEdge";
                public const string Data = "Data";
            }
        }

        public static readonly System.Collections.Generic.HashSet<string> SupportedExtensions = new(System.StringComparer.OrdinalIgnoreCase)
        {
            ".JPG", ".JPEG", ".ARW", ".NEF", ".CR2", ".CR3", ".DNG", ".RAF", ".RW2", ".ORF", ".PNG", ".HEIC", ".TIF", ".TIFF"
        };

        public static readonly System.Collections.Generic.HashSet<string> RawExtensions = new(System.StringComparer.OrdinalIgnoreCase)
        {
            ".ARW", ".NEF", ".CR2", ".CR3", ".DNG", ".RAF", ".RW2", ".ORF"
        };
    }
}
