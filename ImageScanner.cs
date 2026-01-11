using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using MetadataExtractor;

namespace PhotoLibrary
{
    public class ImageScanner
    {
        private readonly DatabaseManager _db;
        private const int MaxHeaderBytes = 1024 * 1024; // 1MB

        public ImageScanner(DatabaseManager db)
        {
            _db = db;
        }

        public void Scan(string directoryPath, bool testOne = false)
        {
            var root = new DirectoryInfo(directoryPath);
            if (!root.Exists)
            {
                Console.WriteLine($"Directory not found: {directoryPath}");
                return;
            }

            Console.WriteLine($"Scanning {directoryPath}...");
            int count = 0;

            // Enumerate all files recursively
            var files = root.EnumerateFiles("*", SearchOption.AllDirectories);

            foreach (var file in files)
            {
                try
                {
                    ProcessFile(file, directoryPath);
                    count++;
                    if (count % 10 == 0) Console.Write(".");

                    if (testOne)
                    {
                        Console.WriteLine($"\nProcessed single file: {file.Name}");
                        break;
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"\nError processing {file.FullName}: {ex.Message}");
                }
            }
            Console.WriteLine($"\nScanned {count} files.");
        }

        private void ProcessFile(FileInfo file, string rootScanPath)
        {
            // Get Directory ID from DB
            string? dirPath = file.DirectoryName;
            if (dirPath == null) return; // Should not happen for file on disk

            string dirId = _db.GetOrCreateDirectory(dirPath);

            var entry = new FileEntry
            {
                DirectoryId = dirId,
                FileName = file.Name,
                RelativePath = Path.GetRelativePath(rootScanPath, file.FullName),
                // FullPath removed per requirement
                Size = file.Length,
                CreatedAt = file.CreationTime,
                ModifiedAt = file.LastWriteTime
            };

            _db.UpsertFileEntry(entry);
            var fileId = _db.GetFileId(entry.DirectoryId, entry.FileName);

            if (fileId != null)
            {
                var metadata = ExtractMetadata(file);
                _db.InsertMetadata(fileId, metadata);
            }
        }

        private IEnumerable<MetadataItem> ExtractMetadata(FileInfo file)
        {
            var items = new List<MetadataItem>();
            try
            {
                // Read first 1MB
                byte[] buffer = new byte[Math.Min(file.Length, MaxHeaderBytes)];
                using (var fs = file.Open(FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    fs.Read(buffer, 0, buffer.Length);
                }

                using (var ms = new MemoryStream(buffer))
                {
                    var directories = ImageMetadataReader.ReadMetadata(ms);
                    foreach (var directory in directories)
                    {
                        foreach (var tag in directory.Tags)
                        {
                            // Filter unknown tags
                            if (tag.Name.StartsWith("Unknown tag", StringComparison.OrdinalIgnoreCase))
                            {
                                continue;
                            }

                            items.Add(new MetadataItem
                            {
                                Directory = directory.Name,
                                Tag = tag.Name,
                                Value = tag.Description ?? ""
                            });
                        }
                    }
                }
            }
            catch (ImageProcessingException)
            {
                // Not an image or unknown format
            }
            catch (Exception)
            {
                // Log debug if needed
            }
            return items;
        }
    }
}