using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.IO.Hashing;
using System.Diagnostics;
using Microsoft.Data.Sqlite;
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
    private Microsoft.Data.Sqlite.SqliteTransaction? _sharedTransaction;
    private int _processedSinceCleanup = 0;

    private Action<string, string>? _onFileProcessed;
    public void RegisterFileProcessedHandler(Action<string, string> handler) => _onFileProcessed = handler;

    public static void SetProgress(bool isIndexing, int indexed, int total)
    {
        IsIndexing = isIndexing;
        IndexedCount = indexed;
        TotalToIndex = total;
    }

    public ImageIndexer(DatabaseManager db, ILogger<ImageIndexer> logger, PreviewManager? previewManager = null, int[]? longEdges = null, Microsoft.Data.Sqlite.SqliteConnection? connection = null, Microsoft.Data.Sqlite.SqliteTransaction? transaction = null)
    {
        _db = db;
        _logger = logger;
        _previewManager = previewManager;
        _longEdges = longEdges ?? Array.Empty<int>();
        _sharedConnection = connection;
        _sharedTransaction = transaction;
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
        ProcessSingleFileInternal(file, file.FullName, scanRootPath);
        _logger.LogDebug("[INDEXER] ProcessSingleFile END: {FileName}", file.Name);
    }

    public void ProcessSingleFileFromSource(FileInfo sourceFile, string targetPath, string scanRootPath, string? hash = null)
    {
        _logger.LogDebug("[INDEXER] ProcessSingleFileFromSource START: {Source} -> {Target}", sourceFile.Name, targetPath);
        ProcessSingleFileInternal(sourceFile, targetPath, scanRootPath, hash);
        _logger.LogDebug("[INDEXER] ProcessSingleFileFromSource END: {Target}", targetPath);
    }

    private void ProcessSingleFileInternal(FileInfo readFile, string dbPath, string scanRootPath, string? hash = null)
    {
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

            string baseRootId = _db.GetOrCreateBaseRootWithConnection(_sharedConnection!, _sharedTransaction, parentDir!);
            string targetRootId = _db.GetOrCreateChildRootWithConnection(_sharedConnection!, _sharedTransaction, baseRootId, targetName);
            
            _pathCache[fullScanPath] = targetRootId;
            
            ProcessFileInternal(readFile, dbPath, fullScanPath, targetRootId, hash);
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

    private bool ProcessFile(FileInfo file, string scanRootPath, string scanRootId)
    {
        return ProcessFileInternal(file, file.FullName, scanRootPath, scanRootId);
    }

    private bool ProcessFileInternal(FileInfo sourceFile, string targetPath, string scanRootPath, string scanRootId, string? providedHash = null)
    {
        if (!TableConstants.SupportedExtensions.Contains(sourceFile.Extension)) return false;

        string? dirPath = Path.GetDirectoryName(targetPath);
        if (dirPath == null) return false;
        dirPath = Path.GetFullPath(dirPath);

        var (exists, lastIndexedModified) = _db.GetExistingFileStatus(targetPath, _sharedConnection);
        if (exists && lastIndexedModified.HasValue && Math.Abs((sourceFile.LastWriteTime - lastIndexedModified.Value).TotalSeconds) < 1)
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
                            currentId = _db.GetOrCreateChildRootWithConnection(_sharedConnection!, _sharedTransaction, currentId, part);
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
            var data = PrepareFileData(sourceFile, targetPath, rootPathId, providedHash);
            CommitFileDataWithConnection(_sharedConnection!, _sharedTransaction, data);
            
            // Notify UI only after everything is ready (DB + Previews)
            _onFileProcessed?.Invoke(data.Entry.Id, targetPath);

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
            _logger.LogError(ex, "Failed to process file {FileName}", sourceFile.Name);
            return false;
        }
    }

    public ProcessedFileData PrepareFileData(FileInfo sourceFile, string targetPath, string targetRootId, string? providedHash = null)
    {
        using var fs = sourceFile.Open(FileMode.Open, FileAccess.Read, FileShare.Read);
        using var stream = new ReadTrackingStream(fs, b => RuntimeStatistics.Instance.RecordBytesReceived(b));
        
        string hash = providedHash ?? CalculateHash(stream);
        stream.Position = 0;

        var entry = new FileEntry
        {
            RootPathId = targetRootId,
            FileName = Path.GetFileName(targetPath),
            Size = sourceFile.Length,
            CreatedAt = sourceFile.CreationTime,
            ModifiedAt = sourceFile.LastWriteTime,
            Hash = hash
        };

        var metadata = ExtractMetadata(stream, sourceFile.Extension).ToList();
        var previews = new List<GeneratedPreview>();

        if (_previewManager != null && _longEdges.Length > 0)
        {
            stream.Position = 0;
            previews = GeneratePreviewsInternal(stream, sourceFile.Name, sourceFile.Extension, sourceFile.DirectoryName!);
        }

        return new ProcessedFileData(entry, metadata, previews);
    }

    public void CommitFileDataWithConnection(System.Data.Common.DbConnection connection, System.Data.Common.DbTransaction? transaction, ProcessedFileData data)
    {
        _db.UpsertFileEntryWithConnection((SqliteConnection)connection, (SqliteTransaction?)transaction, data.Entry);
        var fileId = _db.GetFileIdWithConnection((SqliteConnection)connection, (SqliteTransaction?)transaction, data.Entry.RootPathId, data.Entry.FileName!);

        if (fileId != null)
        {
            _db.InsertMetadataWithConnection((SqliteConnection)connection, (SqliteTransaction?)transaction, fileId, data.Metadata);

            if (_previewManager != null)
            {
                foreach (var preview in data.Previews)
                {
                    _previewManager.SavePreview(data.Entry.Hash!, preview.Size, preview.Data);
                }
            }
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
                var previews = GeneratePreviewsInternal(stream, file.Name, file.Extension, file.DirectoryName!);
                foreach (var p in previews) _previewManager!.SavePreview(hash, p.Size, p.Data);
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
        string? hash = _db.GetFileHash(fileEntryId);
        if (hash == null) return;
        var previews = GeneratePreviewsInternal(stream, file.Name, file.Extension, file.DirectoryName!);
        foreach (var p in previews) _previewManager!.SavePreview(hash, p.Size, p.Data);
    }

    private List<GeneratedPreview> GeneratePreviewsInternal(Stream stream, string fileName, string extension, string directoryName)
    {
        var results = new List<GeneratedPreview>();
        Stream sourceStream = stream;
        bool ownStream = false;
        MagickFormat format = GetMagickFormat(fileName);

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
                format = MagickFormat.Jpg;
            }
        }

        try
        {
            _currentProcess.Refresh();
            _logger.LogDebug("[MAGICK] Indexer Loading {FileName}. Process Mem: {Memory}MB", fileName, _currentProcess.WorkingSet64 / 1024 / 1024);
            
            var settings = new MagickReadSettings {
                Format = format
            };

            using (var image = new MagickImage(sourceStream, settings))
            {
                _logger.LogDebug("Loaded {FileName}. Size: {W}x{H} (Format: {Format})", fileName, image.Width, image.Height, settings.Format);
                image.AutoOrient();
                foreach (var size in _longEdges)
                {
                    using (var clone = image.Clone())
                    {
                        if (clone.Width > clone.Height) clone.Resize((uint)size, 0);
                        else clone.Resize(0, (uint)size);

                        clone.Format = MagickFormat.WebP;
                        clone.Quality = 80; 
                        
                        results.Add(new GeneratedPreview(size, clone.ToByteArray()));
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
        return results;
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
