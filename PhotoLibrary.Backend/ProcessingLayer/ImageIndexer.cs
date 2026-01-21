using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.IO.Hashing;
using System.Diagnostics;
using ImageMagick;
using MetadataExtractor;
using Microsoft.Extensions.Logging;

namespace PhotoLibrary.Backend;

public class ImageIndexer : IImageIndexer
{
    public static bool IsIndexing { get; private set; }
    public static int IndexedCount { get; private set; }
    public static int TotalToIndex { get; private set; }

    private readonly DatabaseManager _db;
    private readonly PreviewManager? _previewManager;
    private readonly int[] _longEdges;
    private readonly ILogger<ImageIndexer> _logger;
    private readonly Dictionary<string, string> _pathCache = new Dictionary<string, string>();
    private static readonly Process _currentProcess = Process.GetCurrentProcess();
    
    private Microsoft.Data.Sqlite.SqliteConnection? _sharedConnection;
    private int _processedSinceCleanup = 0;

    private Action<string, string>? _onFileProcessed;
    public void RegisterFileProcessedHandler(Action<string, string> handler) => _onFileProcessed = handler;

    public static void SetProgress(bool isIndexing, int indexed, int total)
    {
        IsIndexing = isIndexing;
        IndexedCount = indexed;
        TotalToIndex = total;
    }

    public ImageIndexer(DatabaseManager db, ILogger<ImageIndexer> logger, PreviewManager? previewManager = null, int[]? longEdges = null, Microsoft.Data.Sqlite.SqliteConnection? connection = null)
    {
        _db = db;
        _logger = logger;
        _previewManager = previewManager;
        _longEdges = longEdges ?? Array.Empty<int>();
        _sharedConnection = connection;
    }

    public void Scan(string directoryPath, bool testOne = false, int? limit = null)
    {
        var root = new DirectoryInfo(directoryPath);
        if (!root.Exists)
        {
            _logger.LogError("Directory not found: {DirectoryPath}", directoryPath);
            return;
        }

        bool ownConnection = false;
        if (_sharedConnection == null)
        {
            _sharedConnection = _db.GetOpenConnection();
            ownConnection = true;
        }

        try
        {
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
                        PerformPeriodicCleanup();
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
        finally
        {
            if (ownConnection)
            {
                _sharedConnection?.Dispose();
                _sharedConnection = null;
            }
        }
    }

    private void PerformPeriodicCleanup()
    {
        _pathCache.Clear();
        _db.ClearCaches();
        GC.Collect(1, GCCollectionMode.Optimized, false);
    }

    public void ProcessSingleFile(FileInfo file, string scanRootPath)
    {
        _logger.LogDebug("[INDEXER] ProcessSingleFile START: {FileName}", file.Name);
        string fullScanPath = Path.GetFullPath(scanRootPath);
        
        bool ownConnection = false;
        if (_sharedConnection == null)
        {
            _sharedConnection = _db.GetOpenConnection();
            ownConnection = true;
        }

        try
        {
            string? parentDir = Path.GetDirectoryName(fullScanPath);
            string targetName = Path.GetFileName(fullScanPath);

            if (parentDir == null) parentDir = fullScanPath;

            string baseRootId = _db.GetOrCreateBaseRoot(parentDir!);
            string targetRootId = _db.GetOrCreateChildRoot(baseRootId, targetName);
            
            _pathCache[fullScanPath] = targetRootId;
            
            ProcessFile(file, fullScanPath, targetRootId);
        }
        finally
        {
            if (ownConnection)
            {
                _sharedConnection?.Dispose();
                _sharedConnection = null;
            }
        }
        _logger.LogDebug("[INDEXER] ProcessSingleFile END: {FileName}", file.Name);
    }

    private bool ProcessFile(FileInfo file, string scanRootPath, string scanRootId)
    {
        if (!TableConstants.SupportedExtensions.Contains(file.Extension)) return false;

        string? dirPath = file.DirectoryName;
        if (dirPath == null) return false;
        dirPath = Path.GetFullPath(dirPath);

        var (exists, lastIndexedModified) = _db.GetExistingFileStatus(file.FullName, _sharedConnection);
        if (exists && lastIndexedModified.HasValue && Math.Abs((file.LastWriteTime - lastIndexedModified.Value).TotalSeconds) < 1)
        {
            return false; 
        }

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

        try
        {
            using var fs = file.Open(FileMode.Open, FileAccess.Read, FileShare.Read);
            using var stream = new ReadTrackingStream(fs, b => RuntimeStatistics.Instance.RecordBytesReceived(b));
            
            string hash = CalculateHash(stream);
            stream.Position = 0;

            var entry = new FileEntry
            {
                RootPathId = rootPathId,
                FileName = file.Name,
                Size = file.Length,
                CreatedAt = file.CreationTime,
                ModifiedAt = file.LastWriteTime,
                Hash = hash
            };

            _db.UpsertFileEntryWithConnection(_sharedConnection!, null, entry);
            var fileId = _db.GetFileIdWithConnection(_sharedConnection!, null, entry.RootPathId, entry.FileName!);

            if (fileId != null)
            {
                var metadata = ExtractMetadata(stream, file.Extension);
                _db.InsertMetadataWithConnection(_sharedConnection!, null, fileId, metadata);

                if (_previewManager != null && _longEdges.Length > 0)
                {
                    stream.Position = 0;
                    GeneratePreviews(stream, fileId, file.Name, file.Extension, file.DirectoryName!);
                }
                
                // Notify UI only after everything is ready (DB + Previews)
                _onFileProcessed?.Invoke(fileId, file.FullName);
            }

            _processedSinceCleanup++;
            if (_processedSinceCleanup >= 500)
            {
                PerformPeriodicCleanup();
                _processedSinceCleanup = 0;
            }

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to process file {FileName}", file.Name);
            return false;
        }
    }

    private string CalculateHash(Stream stream)
    {
        var hasher = new XxHash64();
        hasher.Append(stream);
        return Convert.ToHexString(hasher.GetCurrentHash()).ToLowerInvariant();
    }

    // REQ-SVC-00007
    public ThumbnailResult EnsureThumbnails(string fileEntryId)
    {
        string? fullPath = _db.GetFullFilePath(fileEntryId);
        if (fullPath == null || !File.Exists(fullPath)) return ThumbnailResult.Error;

        string? hash = _db.GetFileHash(fileEntryId);
        
        // Even if hash exists, we must check if thumbnails actually exist in the CURRENT previews.db
        if (hash != null)
        {
            bool allExist = true;
            foreach (var size in _longEdges)
            {
                if (_previewManager != null && !_previewManager.HasPreview(hash, size))
                {
                    allExist = false;
                    break;
                }
            }
            if (allExist) return ThumbnailResult.Skipped;
        }

        var file = new FileInfo(fullPath);
        try
        {
            using var fs = file.Open(FileMode.Open, FileAccess.Read, FileShare.Read);
            using var stream = new ReadTrackingStream(fs, b => RuntimeStatistics.Instance.RecordBytesReceived(b));
            bool wasHashed = false;

            if (hash == null)
            {
                long hashStart = Stopwatch.GetTimestamp();
                hash = CalculateHash(stream);
                _db.UpdateFileHash(fileEntryId, hash);
                stream.Position = 0;
                wasHashed = true;
                _logger.LogInformation("Hashed {FileName} in {Elapsed}ms", file.Name, Stopwatch.GetElapsedTime(hashStart).TotalMilliseconds.ToString("F2"));
            }

            // Double check previews now that we have the hash (always check, don't assume)
            bool missingAny = false;
            foreach (var size in _longEdges)
            {
                if (_previewManager != null && !_previewManager.HasPreview(hash, size))
                {
                    missingAny = true;
                    break;
                }
            }

            if (missingAny)
            {
                long genStart = Stopwatch.GetTimestamp();
                GeneratePreviews(stream, fileEntryId, file.Name, file.Extension, file.DirectoryName!);
                _logger.LogInformation("Generated previews for {FileName} in {Elapsed}ms", file.Name, Stopwatch.GetElapsedTime(genStart).TotalMilliseconds.ToString("F2"));
                return wasHashed ? ThumbnailResult.HashedAndGenerated : ThumbnailResult.Generated;
            }

            return wasHashed ? ThumbnailResult.HashedAndGenerated : ThumbnailResult.Skipped;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to ensure thumbnails for {FileId} at {Path}", fileEntryId, fullPath);
            return ThumbnailResult.Error;
        }
    }

    public void GeneratePreviews(FileInfo file, string fileEntryId)
    {
        using var fs = file.Open(FileMode.Open, FileAccess.Read, FileShare.Read);
        using var stream = new ReadTrackingStream(fs, b => RuntimeStatistics.Instance.RecordBytesReceived(b));
        GeneratePreviews(stream, fileEntryId, file.Name, file.Extension, file.DirectoryName!);
    }

    private void GeneratePreviews(Stream stream, string fileEntryId, string fileName, string extension, string directoryName)
    {
        bool missingAny = false;
        
        // Get the hash again (ensure we are consistent)
        string? hash = _db.GetFileHash(fileEntryId);
        if (hash == null) return;

        foreach (var size in _longEdges)
        {
            if (!_previewManager!.HasPreview(hash, size))
            {
                missingAny = true;
                break;
            }
        }

        if (!missingAny) return;

        Stream sourceStream = stream;
        bool ownStream = false;

        if (TableConstants.RawExtensions.Contains(extension))
        {
            string nameNoExt = Path.GetFileNameWithoutExtension(fileName);
            string jpgPath = Path.Combine(directoryName, nameNoExt + ".JPG");
            if (!File.Exists(jpgPath)) jpgPath = Path.Combine(directoryName, nameNoExt + ".jpg");
            
            if (File.Exists(jpgPath)) 
            {
                _logger.LogDebug("Found sidecar JPG for {FileName}: {Sidecar}", fileName, jpgPath);
                var fs = File.Open(jpgPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                sourceStream = new ReadTrackingStream(fs, b => RuntimeStatistics.Instance.RecordBytesReceived(b));
                ownStream = true;
            }
        }

        try
        {
            _currentProcess.Refresh();
            _logger.LogDebug("[MAGICK] Indexer Loading {FileName}. Process Mem: {Memory}MB", fileName, _currentProcess.WorkingSet64 / 1024 / 1024);
            
            var settings = new MagickReadSettings {
                Format = GetMagickFormat(fileName)
            };

            using (var image = new MagickImage(sourceStream, settings))
            {
                _logger.LogDebug("Loaded {FileName}. Size: {W}x{H} (Format: {Format})", fileName, image.Width, image.Height, settings.Format);
                image.AutoOrient();
                foreach (var size in _longEdges)
                {
                    if (_previewManager!.HasPreview(hash, size)) continue;

                    using (var clone = image.Clone())
                    {
                        if (clone.Width > clone.Height) clone.Resize((uint)size, 0);
                        else clone.Resize(0, (uint)size);

                        clone.Format = MagickFormat.WebP;
                        clone.Quality = 80; 
                        
                        byte[] data = clone.ToByteArray();
                        _previewManager.SavePreview(hash, size, data);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to generate preview for {FileName}", fileName);
        }
        finally
        {
            if (ownStream) sourceStream.Dispose();
            _currentProcess.Refresh();
            if (_currentProcess.WorkingSet64 > 1024L * 1024 * 1024) {
                GC.Collect(1, GCCollectionMode.Optimized, false);
            }
        }
    }

    private static MagickFormat GetMagickFormat(string path)
    {
        string ext = Path.GetExtension(path).ToLowerInvariant();
        return ext switch
        {
            ".arw" => MagickFormat.Arw,
            ".nef" => MagickFormat.Nef,
            ".cr2" => MagickFormat.Cr2,
            ".cr3" => MagickFormat.Cr3,
            ".dng" => MagickFormat.Dng,
            ".orf" => MagickFormat.Orf,
            ".raf" => MagickFormat.Raf,
            ".rw2" => MagickFormat.Rw2,
            ".jpg" or ".jpeg" => MagickFormat.Jpg,
            ".png" => MagickFormat.Png,
            ".webp" => MagickFormat.WebP,
            _ => MagickFormat.Unknown
        };
    }

    private IEnumerable<MetadataItem> ExtractMetadata(Stream stream, string extension)
    {
        var items = new List<MetadataItem>();
        try
        {
            int maxHeaderBytes = extension.Equals(".cr3", StringComparison.OrdinalIgnoreCase) ? 1024 * 1024 : 256 * 1024;
            byte[] buffer = new byte[Math.Min(stream.Length, maxHeaderBytes)];
            int read = stream.Read(buffer, 0, buffer.Length);

            using (var ms = new MemoryStream(buffer, 0, read))
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
        catch (Exception) { }
        return items;
    }
}