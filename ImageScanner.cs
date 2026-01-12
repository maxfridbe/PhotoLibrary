using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using ImageMagick;
using MetadataExtractor;
using Microsoft.Extensions.Logging;

namespace PhotoLibrary
{
    public class ImageScanner
    {
        private readonly DatabaseManager _db;
        private readonly PreviewManager? _previewManager;
        private readonly int[] _longEdges;
        private readonly ILogger<ImageScanner> _logger;
        private const int MaxHeaderBytes = 1024 * 1024; // 1MB
        private readonly Dictionary<string, string> _pathCache = new Dictionary<string, string>();

        public event Action<string, string>? OnFileProcessed;

        public ImageScanner(DatabaseManager db, ILogger<ImageScanner> logger, PreviewManager? previewManager = null, int[]? longEdges = null)
        {
            _db = db;
            _logger = logger;
            _previewManager = previewManager;
            _longEdges = longEdges ?? Array.Empty<int>();
        }

        public void Scan(string directoryPath, bool testOne = false, int? limit = null)
        {
            var root = new DirectoryInfo(directoryPath);
            if (!root.Exists)
            {
                _logger.LogError("Directory not found: {DirectoryPath}", directoryPath);
                return;
            }

            string fullScanPath = root.FullName;
            _logger.LogInformation("Scanning {FullScanPath}...", fullScanPath);
            
            string? parentDir = Path.GetDirectoryName(fullScanPath);
            string targetName = root.Name;

            if (parentDir == null) parentDir = fullScanPath;

            string baseRootId = _db.GetOrCreateBaseRoot(parentDir!);
            string targetRootId = _db.GetOrCreateChildRoot(baseRootId, targetName);
            
            _pathCache[fullScanPath] = targetRootId;

            int count = 0;
            int importedCount = 0;
            var files = root.EnumerateFiles("*", SearchOption.AllDirectories);

            foreach (var file in files)
            {
                try
                {
                    bool wasImported = ProcessFile(file, fullScanPath, targetRootId);
                    count++;

                    if (wasImported)
                    {
                        importedCount++;
                        if (limit.HasValue && importedCount >= limit.Value)
                        {
                            _logger.LogInformation("Limit of {Limit} imports reached.", limit.Value);
                            break;
                        }
                    }

                    if (count % 1000 == 0) {
                        _logger.LogInformation("Indexed {Count} files...", count);
                    }

                    if (testOne)
                    {
                        _logger.LogInformation("Processed single file: {FileName}", file.Name);
                        break;
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error processing {FileFullName}", file.FullName);
                }
            }
            _logger.LogInformation("Scanned {Count} files total. Imported/Updated {ImportedCount}.", count, importedCount);
        }

        public void ProcessSingleFile(FileInfo file, string scanRootPath)
        {
            _logger.LogDebug("[SCANNER] ProcessSingleFile START: {FileName}", file.Name);
            string fullScanPath = Path.GetFullPath(scanRootPath);
            string? parentDir = Path.GetDirectoryName(fullScanPath);
            string targetName = Path.GetFileName(fullScanPath);

            if (parentDir == null) parentDir = fullScanPath;

            string baseRootId = _db.GetOrCreateBaseRoot(parentDir!);
            string targetRootId = _db.GetOrCreateChildRoot(baseRootId, targetName);
            
            // Optimization: ensure path cache is warm for this root
            _pathCache[fullScanPath] = targetRootId;
            
            ProcessFile(file, fullScanPath, targetRootId);
            _logger.LogDebug("[SCANNER] ProcessSingleFile END: {FileName}", file.Name);
        }

        private bool ProcessFile(FileInfo file, string scanRootPath, string scanRootId)
        {
            if (!TableConstants.SupportedExtensions.Contains(file.Extension)) return false;

            string? dirPath = file.DirectoryName;
            if (dirPath == null) return false;
            dirPath = Path.GetFullPath(dirPath);

            // Optimization: Check if file exists and hasn't changed
            var (exists, lastIndexedModified) = _db.GetExistingFileStatus(file.FullName);
            if (exists && lastIndexedModified.HasValue && Math.Abs((file.LastWriteTime - lastIndexedModified.Value).TotalSeconds) < 1)
            {
                return false; // Skip entirely
            }

            bool isNew = !exists;

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
                    else return false; 
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
                OnFileProcessed?.Invoke(fileId, file.FullName);
                var metadata = ExtractMetadata(file);
                _db.InsertMetadata(fileId, metadata);

                if (_previewManager != null && _longEdges.Length > 0)
                {
                    GeneratePreviews(file, fileId);
                }
            }
            return true;
        }

        public void GeneratePreviews(FileInfo file, string fileId)
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
                _logger.LogError(ex, "Failed to generate preview for {FileName}", file.Name);
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