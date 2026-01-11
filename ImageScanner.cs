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
                // Basic filter for images/videos could be added here, but requirement implied "scan directory"
                // We'll try to read metadata from everything and just fail gracefully if not supported.
                
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

        private void ProcessFile(FileInfo file, string rootPath)
        {
            var entry = new FileEntry
            {
                // We don't set Id here if we want to reuse existing one, but Upsert logic handles it?
                // Actually, our Upsert logic in DatabaseManager inserts a NEW Id if not found, 
                // but if found, it updates fields. It doesn't update ID.
                // So we can generate a temporary ID here, but we should rely on the DB to confirm the ID.
                // Let's generate one; if we update, the DB ignores this new ID and keeps the old one.
                
                RootPath = rootPath,
                FileName = file.Name,
                RelativePath = Path.GetRelativePath(rootPath, file.FullName),
                FullPath = file.FullName,
                Size = file.Length,
                CreatedAt = file.CreationTime,
                ModifiedAt = file.LastWriteTime
            };

            _db.UpsertFileEntry(entry);
            var fileId = _db.GetFileId(entry.FullPath);

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
                // Console.WriteLine($"Debug: {ex.Message}");
            }
            return items;
        }
    }
}
