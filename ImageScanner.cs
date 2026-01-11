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
        // Cache to avoid hitting DB for every file in same dir
        private readonly Dictionary<string, string> _pathCache = new Dictionary<string, string>();

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
            
            // Setup the Root Base
            // Logic: 
            // 1. Identify Parent of the scan target (Base Root)
            // 2. Identify Name of scan target (Child Root) 
            
            string fullScanPath = root.FullName; // Absolute path
            string? parentDir = Path.GetDirectoryName(fullScanPath);
            string targetName = root.Name;

            if (parentDir == null)
            {
                // Scanning system root?
                parentDir = fullScanPath; 
                // Special case logic might be needed, but assuming user scans a folder.
            }

            // Ensure Base Root exists
            string baseRootId = _db.GetOrCreateBaseRoot(parentDir!);
            
            // Ensure Target Root exists
            string targetRootId = _db.GetOrCreateChildRoot(baseRootId, targetName);
            
            // Cache the target root ID for the full scan path
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

            // Resolve the correct RootPathId for this file
            string rootPathId;

            if (dirPath == scanRootPath)
            {
                rootPathId = scanRootId;
            }
            else
            {
                // Subdirectory logic
                if (!_pathCache.TryGetValue(dirPath, out rootPathId!))
                {
                    // Recursively build up to the scan root
                    // This is complex because we need to link back to scanRootId
                    // Simplification: We assume dirPath starts with scanRootPath
                    
                    if (dirPath.StartsWith(scanRootPath))
                    {
                        // Get path relative to scan root
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
                    else
                    {
                        // File is outside scan root? Should not happen with EnumerateFiles
                        return; 
                    }
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
            catch (ImageProcessingException) {{ }}
            catch (Exception) {{ }}
            return items;
        }
    }
}