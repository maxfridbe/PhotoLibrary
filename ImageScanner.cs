using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using ImageMagick;
using MetadataExtractor;

namespace PhotoLibrary
{
    public class ImageScanner
    {
        private readonly DatabaseManager _db;
        private readonly PreviewManager? _previewManager;
        private readonly int[] _longEdges;
        private const int MaxHeaderBytes = 1024 * 1024; // 1MB
        private readonly Dictionary<string, string> _pathCache = new Dictionary<string, string>();

        public ImageScanner(DatabaseManager db, PreviewManager? previewManager = null, int[]? longEdges = null)
        {
            _db = db;
            _previewManager = previewManager;
            _longEdges = longEdges ?? Array.Empty<int>();
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
            
            string fullScanPath = root.FullName;
            string? parentDir = Path.GetDirectoryName(fullScanPath);
            string targetName = root.Name;

            if (parentDir == null) parentDir = fullScanPath;

            string baseRootId = _db.GetOrCreateBaseRoot(parentDir!);
            string targetRootId = _db.GetOrCreateChildRoot(baseRootId, targetName);
            
            _pathCache[fullScanPath] = targetRootId;

            int count = 0;
            var files = root.EnumerateFiles("*", SearchOption.AllDirectories);

            foreach (var file in files)
            {
                try
                {
                    ProcessFile(file, fullScanPath, targetRootId);
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

        private void ProcessFile(FileInfo file, string scanRootPath, string scanRootId)
        {
            string? dirPath = file.DirectoryName;
            if (dirPath == null) return;

            string rootPathId;
            if (dirPath == scanRootPath)
            {
                rootPathId = scanRootId;
            }
            else
            {
                if (!_pathCache.TryGetValue(dirPath, out rootPathId!))
                {
                    if (dirPath.StartsWith(scanRootPath))
                    {
                        string relative = Path.GetRelativePath(scanRootPath, dirPath);
                        string[] parts = relative.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
                        
                        string currentId = scanRootId;
                        string currentPath = scanRootPath;

                        foreach (var part in parts)
                        {
                            currentPath = Path.Combine(currentPath, part);
                            if (_pathCache.TryGetValue(currentPath, out string? cachedId))
                            {
                                currentId = cachedId;
                            }
                            else
                            {
                                currentId = _db.GetOrCreateChildRoot(currentId, part);
                                _pathCache[currentPath] = currentId;
                            }
                        }
                        rootPathId = currentId;
                    }
                    else return; 
                }
            }

            var entry = new FileEntry
            {
                RootPathId = rootPathId,
                FileName = file.Name,
                Size = file.Length,
                CreatedAt = file.CreationTime,
                ModifiedAt = file.LastWriteTime
            };

            _db.UpsertFileEntry(entry);
            var fileId = _db.GetFileId(entry.RootPathId, entry.FileName!);

            if (fileId != null)
            {
                var metadata = ExtractMetadata(file);
                _db.InsertMetadata(fileId, metadata);

                if (_previewManager != null && _longEdges.Length > 0)
                {
                    GeneratePreviews(file, fileId);
                }
            }
        }

        private void GeneratePreviews(FileInfo file, string fileId)
        {
            bool missingAny = false;
            foreach (var size in _longEdges)
            {
                if (!_previewManager!.HasPreview(fileId, size))
                {
                    missingAny = true;
                    break;
                }
            }

            if (!missingAny) return;

            FileInfo sourceFile = file;
            string ext = file.Extension;
            string nameNoExt = Path.GetFileNameWithoutExtension(file.Name);
            string dir = file.DirectoryName!;
            
            if (!ext.Equals(".jpg", StringComparison.OrdinalIgnoreCase) && 
                !ext.Equals(".jpeg", StringComparison.OrdinalIgnoreCase))
            {
                string jpgPath = Path.Combine(dir, nameNoExt + ".JPG");
                if (File.Exists(jpgPath)) sourceFile = new FileInfo(jpgPath);
                else
                {
                    jpgPath = Path.Combine(dir, nameNoExt + ".jpg");
                    if (File.Exists(jpgPath)) sourceFile = new FileInfo(jpgPath);
                }
            }

            try
            {
                using (var image = new MagickImage(sourceFile.FullName))
                {
                    image.AutoOrient();
                    foreach (var size in _longEdges)
                    {
                        if (_previewManager!.HasPreview(fileId, size)) continue;

                        using (var clone = image.Clone())
                        {
                            if (clone.Width > clone.Height)
                            {
                                clone.Resize((uint)size, 0);
                            }
                            else
                            {
                                clone.Resize(0, (uint)size);
                            }

                            clone.Format = MagickFormat.Jpg;
                            clone.Quality = 85; 
                            
                            byte[] data = clone.ToByteArray();
                            _previewManager.SavePreview(fileId, size, data);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Failed to generate preview for {file.Name}: {ex.Message}");
            }
        }

        private IEnumerable<MetadataItem> ExtractMetadata(FileInfo file)
        {
            var items = new List<MetadataItem>();
            try
            {
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
                            if (tag.Name.StartsWith("Unknown tag", StringComparison.OrdinalIgnoreCase))
                                continue;

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
            catch (ImageProcessingException) {{ }}
            catch (Exception) {{ }}
            return items;
        }
    }
}