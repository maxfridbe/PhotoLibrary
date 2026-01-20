using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Reflection;
using Microsoft.Extensions.Logging;
using Microsoft.Data.Sqlite;
using ImageMagick;

namespace PhotoLibrary.Backend;

public class CommunicationLayer : ICommunicationLayer
{
    private readonly IDatabaseManager _db;
    private readonly IPreviewManager _pm;
    private readonly ICameraManager _cm;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger _logger;
    private readonly string _configPath;
    private readonly string _runtimeMode;
    private readonly Func<object, Task> _broadcast;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _activeTasks;
    private readonly ConcurrentDictionary<string, ZipRequest> _exportCache = new();
    private readonly Process _currentProcess = Process.GetCurrentProcess();

    public CommunicationLayer(
        IDatabaseManager db, 
        IPreviewManager pm, 
        ICameraManager cm, 
        ILoggerFactory loggerFactory, 
        string configPath,
        Func<object, Task> broadcast,
        ConcurrentDictionary<string, CancellationTokenSource> activeTasks,
        string runtimeMode = "WebHost")
    {
        _db = db;
        _pm = pm;
        _cm = cm;
        _loggerFactory = loggerFactory;
        _logger = loggerFactory.CreateLogger<CommunicationLayer>();
        _configPath = configPath;
        _runtimeMode = runtimeMode;
        _broadcast = broadcast;
        _activeTasks = activeTasks;
    }

    public ApplicationSettingsResponse GetApplicationSettings()
    {
        var version = Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "Unknown";
        return new ApplicationSettingsResponse {
            RuntimeMode = _runtimeMode,
            Version = version
        };
    }

    public FileResult? GetCameraThumbnail(string model)
    {
        var data = _cm.GetCameraThumbnail(model);
        if (data == null) return null;
        return new FileResult(data);
    }

    public PagedPhotosResponse GetPhotosPaged(PagedPhotosRequest req)
    {
        return _db.GetPhotosPaged(req.limit ?? 100, req.offset ?? 0, req.rootId, req.pickedOnly ?? false, req.rating ?? 0, req.specificIds);
    }

    public List<MetadataGroupResponse> GetMetadata(IdRequest req)
    {
        var flatMetadata = _db.GetMetadata(req.id);
        return flatMetadata
            .GroupBy(m => m.Directory ?? "General")
            .Select(g => new MetadataGroupResponse
            {
                Name = g.Key,
                Items = g.GroupBy(i => i.Tag ?? "")
                         .ToDictionary(tg => tg.Key, tg => tg.First().Value ?? "")
            })
            .ToList();
    }

    public List<DirectoryNodeResponse> GetDirectories()
    {
        return _db.GetDirectoryTree().ToList();
    }

    public LibraryInfoResponse GetLibraryInfo()
    {
        var info = _db.GetLibraryInfo(_pm.DbPath, _configPath);
        info.IsIndexing = ImageIndexer.IsIndexing;
        info.IndexedCount = ImageIndexer.IndexedCount;
        info.TotalToIndex = ImageIndexer.TotalToIndex;
        info.TotalThumbnailedImages = _pm.GetTotalUniqueHashes();

        try
        {
            string backupDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PhotoLibrary", "backup");
            if (Directory.Exists(backupDir))
            {
                info.Backups = new DirectoryInfo(backupDir).GetFiles("*.zip")
                    .OrderByDescending(f => f.CreationTime)
                    .Take(20)
                    .Select(f => new BackupFileResponse { Name = f.Name, Date = f.CreationTime, Size = f.Length })
                    .ToList();
            }
        }
        catch { }

        return info;
    }

    public RpcResult<string> BackupLibrary()
    {
        try
        {
            string backupDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PhotoLibrary", "backup");
            Directory.CreateDirectory(backupDir);
            
            string fileName = $"backup-{DateTime.Now:yyyyMMdd-HHmmss}.zip";
            string fullPath = Path.Combine(backupDir, fileName);

            using var archive = ZipFile.Open(fullPath, ZipArchiveMode.Create);

            void AddFile(string path, string name)
            {
                if (!File.Exists(path)) return;
                try
                {
                    using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    var entry = archive.CreateEntry(name, CompressionLevel.Fastest);
                    using var entryStream = entry.Open();
                    fs.CopyTo(entryStream);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to backup {Name}", name);
                }
            }

            AddFile(_db.DbPath, "cameras.db");
            AddFile(_pm.DbPath, "previews.db");

            return new RpcResult<string>(fullPath);
        }
        catch (Exception ex)
        {
            return new RpcResult<string>(null, false, ex.Message);
        }
    }

    public async Task SetPicked(PickRequest req)
    {
        _db.SetPicked(req.id, req.isPicked);
        await _broadcast(new { type = "photo.picked." + (req.isPicked ? "added" : "removed"), id = req.id });
    }

    public async Task SetRating(RateRequest req)
    {
        _db.SetRating(req.id, req.rating);
        await _broadcast(new { type = "photo.starred.added", id = req.id, rating = req.rating });
    }

    public IEnumerable<string> Search(SearchRequest req)
    {
        return _db.Search(req);
    }

    public IEnumerable<object> GetCollections()
    {
        return _db.GetCollections().Select(c => new { id = c.Id, name = c.Name, count = c.Count });
    }

    public object CreateCollection(NameRequest req)
    {
        var id = _db.CreateCollection(req.name);
        return new { id, name = req.name };
    }

    public void DeleteCollection(IdRequest req)
    {
        _db.DeleteCollection(req.id);
    }

    public void AddFilesToCollection(CollectionAddRequest req)
    {
        _db.AddFilesToCollection(req.collectionId, req.fileIds);
    }

    public IEnumerable<string> GetCollectionFiles(IdRequest req)
    {
        return _db.GetCollectionFiles(req.id);
    }

    public void ClearPicked()
    {
        _db.ClearPicked();
    }

    public IEnumerable<string> GetPickedIds()
    {
        return _db.GetPickedIds();
    }

    public StatsResponse GetStats()
    {
        return _db.GetGlobalStats();
    }

    public List<DirectoryResponse> ListFileSystem(NameRequest req)
    {
        string path = req?.name ?? "";
        
        try 
        {
            IEnumerable<string> dirs;
            if (string.IsNullOrEmpty(path))
            {
#if WINDOWS
                dirs = DriveInfo.GetDrives().Select(d => d.Name);
#else
                dirs = new[] { "/" };
#endif
            }
            else
            {
                string abs = PathUtils.ResolvePath(path);
                if (!Directory.Exists(abs)) return new List<DirectoryResponse>();
                dirs = Directory.GetDirectories(abs).Where(d => 
                {
                    try {
                        var name = Path.GetFileName(d);
                        if (string.IsNullOrEmpty(name) || name.StartsWith(".")) return false;
                        var attr = File.GetAttributes(d);
                        return !attr.HasFlag(FileAttributes.ReparsePoint);
                    } catch { return false; }
                });
            }
            
            return dirs.OrderBy(d => d).Select(d => {
                string name = Path.GetFileName(d);
                if (string.IsNullOrEmpty(name)) name = d; 
                return new DirectoryResponse { 
                    Path = d, 
                    Name = name
                };
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[FS] Error listing directory: {Path}", path);
            return new List<DirectoryResponse>();
        }
    }

    public List<string> FindFiles(NameRequest req)
    {
        if (string.IsNullOrEmpty(req.name)) return new List<string>();
        try
        {
            string absPath = PathUtils.ResolvePath(req.name);
            _logger.LogInformation("[FSFind] Scanning path: {AbsPath}", absPath);
            
            if (!Directory.Exists(absPath)) return new List<string>();

            var foundFiles = new List<string>();
            var stack = new Stack<string>();
            stack.Push(absPath);

            while (stack.Count > 0 && foundFiles.Count < 1000)
            {
                string currentDir = stack.Pop();
                try
                {
                    foreach (string dir in Directory.EnumerateDirectories(currentDir))
                    {
                        var name = Path.GetFileName(dir);
                        if (!name.StartsWith(".")) stack.Push(dir);
                    }

                    foreach (string file in Directory.EnumerateFiles(currentDir))
                    {
                        if (TableConstants.SupportedExtensions.Contains(Path.GetExtension(file)))
                        {
                            foundFiles.Add(Path.GetRelativePath(absPath, file));
                        }
                        if (foundFiles.Count >= 1000) break;
                    }
                }
                catch (UnauthorizedAccessException) { /* Skip restricted dirs */ }
                catch (Exception ex) { _logger.LogDebug("[FSFind] Error in {Dir}: {Msg}", currentDir, ex.Message); }
            }

            return foundFiles;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[FSFind] Error scanning directory: {Path}", req.name);
            return new List<string>();
        }
    }

    public List<string> FindNewFiles(NameRequest req)
    {
        if (string.IsNullOrEmpty(req.name)) return new List<string>();

        int limit = 1000;
        string path = req.name;
        if (path.Contains("|")) {
            var parts = path.Split('|');
            path = parts[0];
            int.TryParse(parts[1], out limit);
        }
        limit = Math.Clamp(limit, 1, 10000);

        try
        {
            string absPath = PathUtils.ResolvePath(path);
            if (!Directory.Exists(absPath)) return new List<string>();
            
            var enumerator = Directory.EnumerateFiles(absPath, "*", SearchOption.AllDirectories)
                .Where(f => TableConstants.SupportedExtensions.Contains(Path.GetExtension(f)));

            var newFiles = new List<string>();
            using var connection = new SqliteConnection($"Data Source={_db.DbPath}");
            connection.Open();

            foreach (var file in enumerator)
            {
                var fullFile = Path.GetFullPath(file);
                if (!_db.FileExists(fullFile, connection))
                {
                    newFiles.Add(Path.GetRelativePath(absPath, fullFile));
                }
                if (newFiles.Count >= limit) break;
            }
            
            return newFiles;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[FindNew] Error");
            return new List<string>();
        }
    }

    public void ImportBatch(ImportBatchRequest req)
    {
        if (req.relativePaths == null) return;

        string taskId = "import-batch";
        var cts = new CancellationTokenSource();
        if (!_activeTasks.TryAdd(taskId, cts)) 
        {
            if (_activeTasks.TryRemove(taskId, out var oldCts))
            {
                oldCts.Cancel();
                oldCts.Dispose();
            }
            _activeTasks.TryAdd(taskId, cts);
        }

        _ = Task.Run(async () =>
        {
            try
            {
                _logger?.LogInformation("[BATCH] TASK START: Processing {Count} files.", req.relativePaths.Length);
                ImageIndexer.SetProgress(true, 0, req.relativePaths.Length);
                
                var sizes = new List<int>();
                if (req.generateLow) sizes.Add(300);
                if (req.generateMedium) sizes.Add(1024);

                IImageIndexer indexer = new ImageIndexer((DatabaseManager)_db, _loggerFactory.CreateLogger<ImageIndexer>(), (PreviewManager)_pm, sizes.ToArray());
                indexer.RegisterFileProcessedHandler((id, path) => 
                {
                    string? fileRootId = _db.GetFileRootId(id);
                    _ = _broadcast(new { type = "file.imported", id, path, rootId = fileRootId });
                });
                
                string absRoot = PathUtils.ResolvePath(req.rootPath);
                _logger?.LogInformation("[BATCH] Resolved Root: {AbsRoot}", absRoot);
                
                int count = 0;
                foreach (var relPath in req.relativePaths)
                {
                    if (cts.Token.IsCancellationRequested) break;
                    try 
                    {
                        string cleanRel = relPath.TrimStart('/');
                        string fullPath = absRoot.TrimEnd('/') + "/" + cleanRel;
                        
                        if (File.Exists(fullPath))
                        {
                            indexer.ProcessSingleFile(new FileInfo(fullPath), absRoot);
                            count++;
                            ImageIndexer.SetProgress(true, count, req.relativePaths.Length);
                            if (count % 10 == 0) _logger?.LogInformation("[BATCH] Progress: {Count}/{Total}...", count, req.relativePaths.Length);
                        }
                        else
                        {
                            _logger?.LogWarning("[BATCH] File not found: {FullPath}", fullPath);
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger?.LogError(ex, "[BATCH] Error processing {RelPath}", relPath);
                    }
                }
                
                _logger?.LogInformation("[BATCH] TASK FINISHED. Imported {Count} files total.", count);
                await _broadcast(new { type = "scan.finished" });
            }
            catch (Exception ex)
            {
                _logger?.LogCritical(ex, "[BATCH] CRITICAL FAILURE");
            }
            finally 
            {
                ImageIndexer.SetProgress(false, 0, 0);
                _activeTasks.TryRemove(taskId, out _);
            }
        });
    }

    public void GenerateThumbnails(GenerateThumbnailsRequest req, Action<ImageRequest, CancellationToken> enqueue)
    {
        _logger.LogInformation("[API] Generate Thumbnails requested for root {RootId} (Recursive: {Recursive}, Force: {Force})", req.rootId, req.recursive, req.force);

        string taskId = $"thumbnails-{req.rootId}";
        var cts = new CancellationTokenSource();
        if (!_activeTasks.TryAdd(taskId, cts)) 
        {
            if (_activeTasks.TryRemove(taskId, out var oldCts))
            {
                oldCts.Cancel();
                oldCts.Dispose();
            }
            _activeTasks.TryAdd(taskId, cts);
        }

        _ = Task.Run(() =>
        {
            try
            {
                var fileIds = _db.GetFileIdsUnderRoot(req.rootId, req.recursive);
                int total = fileIds.Count;
                int processed = 0;
                int thumbnailed = 0;
                _logger?.LogInformation("Enqueuing background thumbnail generation for {Total} files in root {RootId}", total, req.rootId);

                _ = _broadcast(new { type = "folder.progress", rootId = req.rootId, processed = 0, total, thumbnailed = 0 });

                foreach (var fId in fileIds)
                {
                    if (cts.Token.IsCancellationRequested) break;
                    processed++;
                    
                    string? hash = _db.GetFileHash(fId);
                    bool alreadyExists = hash != null && _pm.HasPreview(hash, 300) && _pm.HasPreview(hash, 1024);

                    if (alreadyExists && !req.force)
                    {
                        thumbnailed++;
                    }
                    else
                    {
                        if (req.force && hash != null)
                        {
                            _pm.DeletePreviewsByHash(hash);
                        }
                        enqueue(new ImageRequest { fileId = fId, size = 300, requestId = -1, priority = -1000 }, cts.Token);
                    }

                    if (processed % 50 == 0 || processed == total)
                    {
                        _ = _broadcast(new { 
                            type = "folder.progress", 
                            rootId = req.rootId, 
                            processed, 
                            total,
                            thumbnailed 
                        });
                    }
                }
                
                _logger?.LogInformation("Finished enqueuing background tasks for root {RootId}.", req.rootId);
            }
            catch (Exception ex) { _logger?.LogError(ex, "[WS] Background thumbnail enqueue error"); }
            finally { _activeTasks.TryRemove(taskId, out _); }
        });
    }

    public void SetAnnotation(FolderAnnotationRequest req)
    {
        _db.SetFolderAnnotation(req.folderId, req.annotation, req.color);
    }

    public void ForceUpdatePreview(ForceUpdatePreviewRequest req, Action<ImageRequest, CancellationToken> enqueue)
    {
        string? hash = _db.GetFileHash(req.id);
        if (hash != null)
        {
            _pm.DeletePreviewsByHash(hash);
        }
        
        enqueue(new ImageRequest { fileId = req.id, size = 300, requestId = -1, priority = 100 }, CancellationToken.None);
        enqueue(new ImageRequest { fileId = req.id, size = 1024, requestId = -1, priority = 90 }, CancellationToken.None);
    }

    public bool CancelTask(IdRequest req)
    {
        if (_activeTasks.TryRemove(req.id, out var cts))
        {
            cts.Cancel();
            cts.Dispose();
            return true;
        }
        return false;
    }

    public string? GetSetting(string key)
    {
        return _db.GetSetting(key);
    }

    public void SetSetting(SettingRequest req)
    {
        _db.SetSetting(req.key, req.value);
    }

    public string PrepareExport(ZipRequest req)
    {
        string token = Guid.NewGuid().ToString();
        _exportCache[token] = req;
        _ = Task.Run(async () => { await Task.Delay(TimeSpan.FromMinutes(5)); _exportCache.TryRemove(token, out _); });
        return token;
    }

    public string? GetExportZipName(string token)
    {
        if (_exportCache.TryGetValue(token, out var req))
        {
            return $"{SanitizeFilename(req.name ?? "export")}_{req.type}.zip";
        }
        return null;
    }

    public async Task DownloadExport(string token, Stream outputStream)
    {
        if (!_exportCache.TryRemove(token, out var req) || req.fileIds == null) return;
        
        _logger.LogInformation("[EXPORT] Starting export for {Count} files", req.fileIds.Length);

        using (var archive = new ZipArchive(outputStream, ZipArchiveMode.Create))
        {
            var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var id in req.fileIds)
            {
                try {
                    var (fullPath, rotation, isHidden) = _db.GetExportInfo(id);
                    if (isHidden) { _logger.LogInformation("[EXPORT] Skipping hidden file {Id}", id); continue; }
                    if (string.IsNullOrEmpty(fullPath)) { _logger.LogWarning("[EXPORT] Path not found for {Id}", id); continue; }
                    if (!File.Exists(fullPath)) { _logger.LogWarning("[EXPORT] File does not exist on disk: {Path}", fullPath); continue; }

                    string entryName = (req.type == "previews" || TableConstants.RawExtensions.Contains(Path.GetExtension(fullPath))) ? Path.GetFileNameWithoutExtension(fullPath) + ".jpg" : Path.GetFileName(fullPath);
                    string uniqueName = entryName;
                    int counter = 1;
                    while (usedNames.Contains(uniqueName)) { string ext = Path.GetExtension(entryName); string nameNoExt = Path.GetFileNameWithoutExtension(entryName); uniqueName = $"{nameNoExt}-{counter}{ext}"; counter++; }
                    usedNames.Add(uniqueName);
                    var entry = archive.CreateEntry(uniqueName, CompressionLevel.NoCompression);
                    using (var entryStream = entry.Open())
                    {
                        bool isRaw = TableConstants.RawExtensions.Contains(Path.GetExtension(fullPath));
                        if (req.type == "previews" || isRaw || rotation != 0) 
                        { 
                            var settings = new MagickReadSettings {
                                Format = GetMagickFormat(fullPath)
                            };
                            using var image = new MagickImage(fullPath, settings); 
                            image.AutoOrient(); 
                            if (rotation != 0) image.Rotate(rotation);
                            image.Format = MagickFormat.Jpg; 
                            image.Quality = 85; 
                            image.Write(entryStream); 
                            _currentProcess.Refresh();
                            if (_currentProcess.WorkingSet64 > 1024L * 1024 * 1024) GC.Collect(1, GCCollectionMode.Optimized, false);
                        }
                        else { using var fs = File.OpenRead(fullPath); await fs.CopyToAsync(entryStream); }
                    }
                } catch (Exception ex) {
                    _logger.LogError(ex, "[EXPORT] Failed to process file {Id}", id);
                }
            }
        }
    }

    public PhysicalFileResult? DownloadFile(string fileId)
    {
        string? fullPath = _db.GetFullFilePath(fileId);
        if (fullPath == null || !File.Exists(fullPath)) return null;
        return new PhysicalFileResult(fullPath, Path.GetFileName(fullPath));
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

    private static string SanitizeFilename(string name)
    {
        foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        return name;
    }

    private static string GetContentType(string path)
    {
        string ext = Path.GetExtension(path).ToLowerInvariant();
        return ext switch
        {
            ".html" => "text/html",
            ".js" => "application/javascript",
            ".css" => "text/css",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            ".svg" => "image/svg+xml",
            ".ico" => "image/x-icon",
            _ => "application/octet-stream",
        };
    }
}