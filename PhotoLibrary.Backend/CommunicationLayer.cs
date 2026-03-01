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
using MetadataExtractor;
using Directory = System.IO.Directory;

namespace PhotoLibrary.Backend;

public class CommunicationLayer : ICommunicationLayer
{
    private readonly IDatabaseManager _db;
    private readonly IPreviewManager _previewManager;
    private readonly PathManager _pathManager = new();
    private readonly ICameraManager _cm;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger _logger;
    private readonly string _configPath;
    private readonly string _runtimeMode;
    private readonly string _mapTilesPath;
    private readonly Func<object, Task> _broadcast;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _activeTasks;
    private readonly ConcurrentDictionary<string, ZipRequest> _exportCache = new();
    private readonly Process _currentProcess = Process.GetCurrentProcess();

    private class QueuedImageRequest
    {
        public ImageRequest Request { get; }
        public TaskCompletionSource<byte[]> Tcs { get; }
        public CancellationToken ct { get; }
        public long StartTime { get; }
        
        public double QueueMs { get; set; }
        public double RetrievalMs { get; set; }
        public double GeneratingMs { get; set; }
        public byte[]? Payload { get; set; }

        public QueuedImageRequest(ImageRequest request, TaskCompletionSource<byte[]> tcs, CancellationToken ct, long startTime)
        {
            Request = request; Tcs = tcs; this.ct = ct; StartTime = startTime;
        }
    }

    private readonly PriorityQueue<QueuedImageRequest, double> _requestQueue = new();
    private readonly SemaphoreSlim _queueSemaphore = new(0);
    private readonly object _queueLock = new();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _fileLocks = new();
    private int _activeMagickTasks = 0;

    public CommunicationLayer(
        IDatabaseManager db, 
        IPreviewManager pm, 
        ICameraManager cm, 
        ILoggerFactory loggerFactory, 
        string configPath,
        Func<object, Task> broadcast,
        ConcurrentDictionary<string, CancellationTokenSource> activeTasks,
        string runtimeMode = "WebHost",
        string mapTilesPath = "")
    {
        _logger = loggerFactory.CreateLogger<CommunicationLayer>();
        _db = db;
        _previewManager = pm;
        _cm = cm;
        _loggerFactory = loggerFactory;
        _configPath = configPath;
        _runtimeMode = runtimeMode;
        _mapTilesPath = mapTilesPath;
        _broadcast = broadcast;
        _activeTasks = activeTasks;

        // Start Background Workers for Image Processing
        int workerCount = Math.Max(1, Environment.ProcessorCount / 2);
        _logger.LogInformation("Starting {Count} background image worker threads.", workerCount);
        for (int i = 0; i < workerCount; i++)
        {
            StartImageWorker();
        }
    }

    private void StartImageWorker()
    {
        Task.Run(async () =>
        {
            while (true)
            {
                await _queueSemaphore.WaitAsync();
                QueuedImageRequest? item = null;
                int remaining = 0;
                lock (_queueLock)
                {
                    _requestQueue.TryDequeue(out item, out _);
                    remaining = _requestQueue.Count;
                }

                if (item == null) continue;
                
                if (remaining % 10 == 0 || remaining < 5)
                {
                    _logger?.LogDebug("[QUEUE] Dequeued request for {Id}. Remaining in queue: {Count}", 
                        item.Request.fileEntryId, remaining);
                }

                if (item.Tcs.Task.IsCompleted) continue;

                long dequeuedTime = Stopwatch.GetTimestamp();
                item.QueueMs = Stopwatch.GetElapsedTime(item.StartTime, dequeuedTime).TotalMilliseconds;

                if (item.ct.IsCancellationRequested)
                {
                    item.Tcs.TrySetCanceled();
                    continue;
                }

                try
                {
                    var req = item.Request;
                    byte[]? data = null;
                    long retrievalStart = Stopwatch.GetTimestamp();

                    if (req.size == 0)
                    {
                        string? fullPath = _db.GetFullFilePath(req.fileEntryId);
                        if (fullPath != null && File.Exists(fullPath))
                        {
                            string ext = Path.GetExtension(fullPath);
                            string sourcePath = fullPath;
                            bool isRaw = TableConstants.RawExtensions.Contains(ext);

                            if (isRaw)
                            {
                                string nameNoExt = Path.GetFileNameWithoutExtension(fullPath);
                                string dir = Path.GetDirectoryName(fullPath) ?? "";
                                string sidecar = Path.Combine(dir, nameNoExt + ".JPG");
                                if (!File.Exists(sidecar)) sidecar = Path.Combine(dir, nameNoExt + ".jpg");
                                if (File.Exists(sidecar)) { sourcePath = sidecar; isRaw = false; }
                            }

                            if (isRaw || Path.GetExtension(sourcePath).Equals(".png", StringComparison.OrdinalIgnoreCase))
                            {
                                item.RetrievalMs = Stopwatch.GetElapsedTime(retrievalStart).TotalMilliseconds;
                                long genStart = Stopwatch.GetTimestamp();
                                var fileLock = _fileLocks.GetOrAdd(req.fileEntryId, _ => new SemaphoreSlim(1, 1));
                                await fileLock.WaitAsync();
                                Interlocked.Increment(ref _activeMagickTasks);
                                try
                                {
                                    using var fs = File.OpenRead(sourcePath);
                                    using var tracker = new ReadTrackingStream(fs, b => RuntimeStatistics.Instance.RecordBytesReceived(b));
                                    
                                    var settings = new MagickReadSettings {
                                        Format = GetMagickFormat(sourcePath)
                                    };
                                    
                                    _currentProcess.Refresh();
                                    long memBefore = _currentProcess.WorkingSet64 / 1024 / 1024;

                                    using var image = new MagickImage(tracker, settings);
                                    image.AutoOrient();
                                    
                                    _currentProcess.Refresh();
                                    long memAfter = _currentProcess.WorkingSet64 / 1024 / 1024;
                                    _logger?.LogDebug("[MAGICK] Loaded {Id} (FullRes). Process Mem: {Before}MB -> {After}MB (+{Diff}MB). Active Tasks: {Active}", 
                                        req.fileEntryId, memBefore, memAfter, memAfter - memBefore, _activeMagickTasks);

                                    image.Format = MagickFormat.WebP;
                                    image.Quality = 90;
                                    data = image.ToByteArray();
                                }
                                finally { 
                                    Interlocked.Decrement(ref _activeMagickTasks); 
                                    fileLock.Release(); 
                                    _currentProcess.Refresh();
                                    if (_currentProcess.WorkingSet64 > 1024L * 1024 * 1024) GC.Collect(1, GCCollectionMode.Optimized, false);
                                }
                                item.GeneratingMs = Stopwatch.GetElapsedTime(genStart).TotalMilliseconds;
                            }
                            else {
                                data = await File.ReadAllBytesAsync(sourcePath, item.ct);
                                RuntimeStatistics.Instance.RecordBytesReceived(data.Length);
                                item.RetrievalMs = Stopwatch.GetElapsedTime(retrievalStart).TotalMilliseconds;
                            }
                        }
                    }
                    else 
                    {
                        string? hash = _db.GetFileHash(req.fileEntryId);
                        data = hash != null ? _previewManager.GetPreviewData(hash, req.size) : null;
                        
                        if (data == null)
                        {
                            string? fullPath = _db.GetFullFilePath(req.fileEntryId);
                            if (fullPath != null && File.Exists(fullPath))
                            {
                                try {
                                    string sourcePath = fullPath;
                                    string ext = Path.GetExtension(fullPath);
                                    bool isRaw = TableConstants.RawExtensions.Contains(ext);
                                    if (isRaw) {
                                        string sidecar = Path.ChangeExtension(fullPath, ".JPG");
                                        if (!File.Exists(sidecar)) sidecar = Path.ChangeExtension(fullPath, ".jpg");
                                        if (File.Exists(sidecar)) { sourcePath = sidecar; isRaw = false; }
                                    }
                                    
                                    using (var fs = File.Open(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read))
                                    using (var stream = new ReadTrackingStream(fs, b => RuntimeStatistics.Instance.RecordBytesReceived(b)))
                                    {
                                        if (hash == null) {
                                            var hasher = new System.IO.Hashing.XxHash64();
                                            hasher.Append(stream);
                                            hash = Convert.ToHexString(hasher.GetCurrentHash()).ToLowerInvariant();
                                            stream.Position = 0;
                                            _db.UpdateFileHash(req.fileEntryId, hash);
                                        }

                                        data = _previewManager.GetPreviewData(hash, req.size);
                                        if (data != null) {
                                            item.RetrievalMs = Stopwatch.GetElapsedTime(retrievalStart).TotalMilliseconds;
                                            item.Payload = data;
                                            item.Tcs.TrySetResult(data);
                                            continue;
                                        }

                                        long genStart = Stopwatch.GetTimestamp();
                                        var fileLock = _fileLocks.GetOrAdd(hash!, _ => new SemaphoreSlim(1, 1));
                                        await fileLock.WaitAsync();
                                        
                                        var existingData = _previewManager.GetPreviewData(hash!, req.size);
                                        if (existingData != null)
                                        {
                                            fileLock.Release();
                                            item.RetrievalMs = Stopwatch.GetElapsedTime(retrievalStart).TotalMilliseconds;
                                            item.Payload = existingData;
                                            item.Tcs.TrySetResult(existingData);
                                            continue;
                                        }

                                        Interlocked.Increment(ref _activeMagickTasks);
                                        try
                                        {
                                            _currentProcess.Refresh();
                                            long memBefore = _currentProcess.WorkingSet64 / 1024 / 1024;
                                            
                                            var settings = new MagickReadSettings {
                                                Format = GetMagickFormat(sourcePath)
                                            };
                                            
                                            using var image = new MagickImage(stream, settings);
                                            _ = _broadcast(new { type = "preview.generating", fileEntryId = req.fileEntryId });
                                            image.AutoOrient();
                                            
                                            _currentProcess.Refresh();
                                            long memAfter = _currentProcess.WorkingSet64 / 1024 / 1024;
                                            _logger?.LogDebug("[MAGICK] Loaded {Id}. Process Mem: {Before}MB -> {After}MB (+{Diff}MB). Active Tasks: {Active}", 
                                                req.fileEntryId, memBefore, memAfter, memAfter - memBefore, _activeMagickTasks);

                                            int[] targetSizes = { 300, 1024 };
                                            foreach (var targetSize in targetSizes)
                                            {
                                                if (!isRaw && image.Width <= targetSize && image.Height <= targetSize)
                                                {
                                                    var bytes = File.ReadAllBytes(sourcePath);
                                                    _previewManager.SavePreview(hash, targetSize, bytes);
                                                    if (targetSize == req.size) data = bytes;
                                                    continue;
                                                }

                                                using (var clone = image.Clone())
                                                {
                                                    if (clone.Width > clone.Height) clone.Resize((uint)targetSize, 0);
                                                    else clone.Resize(0, (uint)targetSize);
                                                    
                                                    clone.Format = MagickFormat.WebP;
                                                    clone.Quality = 80;
                                                    var generated = clone.ToByteArray();
                                                    
                                                    _previewManager.SavePreview(hash, targetSize, generated);
                                                    if (targetSize == req.size) data = generated;
                                                }
                                            }
                                        }
                                        finally { 
                                            Interlocked.Decrement(ref _activeMagickTasks); 
                                            fileLock.Release(); 
                                            _currentProcess.Refresh();
                                            if (_currentProcess.WorkingSet64 > 1024L * 1024 * 1024) {
                                                GC.Collect(1, GCCollectionMode.Optimized, false);
                                            }
                                        }
                                        item.GeneratingMs = Stopwatch.GetElapsedTime(genStart).TotalMilliseconds;
                                        
                                        string? fileRootId = _db.GetFileRootId(req.fileEntryId);
                                        _ = _broadcast(new { type = "preview.generated", fileEntryId = req.fileEntryId, rootId = fileRootId });
                                    }
                                } catch (Exception ex) { _logger?.LogError(ex, "Live Gen Failed for {Id}", req.fileEntryId); }
                            }
                        }
                        item.RetrievalMs = Stopwatch.GetElapsedTime(retrievalStart).TotalMilliseconds - item.GeneratingMs;
                    }

                    byte[] finalData = data ?? Array.Empty<byte>();
                    item.Payload = finalData;

                    // Final diagnostic logging
                    string shortId = req.fileEntryId.Length > 12 ? $"{req.fileEntryId.Substring(0, 4)}...{req.fileEntryId.Substring(req.fileEntryId.Length - 4)}" : req.fileEntryId;
                    double totMs = Stopwatch.GetElapsedTime(item.StartTime).TotalMilliseconds;
                    if (req.priority <= -1000) {
                        _logger?.LogInformation("[THUMB] {Id,-11} | Priority: {Priority,12:F4} | Tot: {Total,9:F1}ms | Q: {Queue,8:F1}ms | Ret: {Ret,8:F1}ms | Gen: {Gen,8:F1}ms",
                            shortId, req.priority, totMs, item.QueueMs, item.RetrievalMs, item.GeneratingMs);
                    } else {
                        _logger?.LogDebug("[FETCH] {Id,-11} | Priority: {Priority,12:F4} | Tot: {Total,9:F1}ms | Q: {Queue,8:F1}ms | Ret: {Ret,8:F1}ms | Gen: {Gen,8:F1}ms",
                            shortId, req.priority, totMs, item.QueueMs, item.RetrievalMs, item.GeneratingMs);
                    }

                    item.Tcs.TrySetResult(finalData);
                }
                catch (Exception ex)
                {
                    item.Tcs.TrySetException(ex);
                }
            }
        });
    }

    public async Task<byte[]> GetImageAsync(ImageRequest req, CancellationToken ct)
    {
        long startTime = Stopwatch.GetTimestamp();
        string? hash = _db.GetFileHash(req.fileEntryId);
        byte[]? immediateData = (hash != null && req.size > 0) ? _previewManager.GetPreviewData(hash, req.size) : null;

        if (immediateData != null)
        {
            string shortId = req.fileEntryId.Length > 12 ? $"{req.fileEntryId.Substring(0, 4)}...{req.fileEntryId.Substring(req.fileEntryId.Length - 4)}" : req.fileEntryId;
            double totMs = Stopwatch.GetElapsedTime(startTime).TotalMilliseconds;
            if (req.priority <= -1000) {
                _logger?.LogInformation("[THUMB] {Id,-11} | Priority: {Priority,12:F4} | Tot: {Total,9:F1}ms | FASTPATH",
                    shortId, req.priority, totMs);
            } else {
                _logger?.LogDebug("[FETCH] {Id,-11} | Priority: {Priority,12:F4} | Tot: {Total,9:F1}ms | FASTPATH",
                    shortId, req.priority, totMs);
            }
            return immediateData;
        }

        var tcs = new TaskCompletionSource<byte[]>();
        lock (_queueLock)
        {
            var reqObj = new QueuedImageRequest(req, tcs, ct, startTime);
            _requestQueue.Enqueue(reqObj, -req.priority);
            if (_requestQueue.Count % 10 == 0 || _requestQueue.Count < 5)
            {
                _logger?.LogDebug("[QUEUE] Enqueued request for {Id} (Size: {Size}). Total in queue: {Count}", 
                    req.fileEntryId, req.size, _requestQueue.Count);
            }
        }
        _queueSemaphore.Release();
        return await tcs.Task;
    }

    public async Task<byte[]?> GetMapTileAsync(int z, int x, int y)
    {
        if (string.IsNullOrEmpty(_mapTilesPath) || !File.Exists(_mapTilesPath))
        {
            return null;
        }

        try {
            using var connection = new SqliteConnection($"Data Source={_mapTilesPath};Mode=ReadOnly");
            await connection.OpenAsync();

            // MBTiles uses TMS (y-axis is flipped)
            int tmsY = (1 << z) - 1 - y;

            var command = connection.CreateCommand();
            command.CommandText = "SELECT tile_data FROM tiles WHERE zoom_level = @z AND tile_column = @x AND tile_row = @y";
            command.Parameters.AddWithValue("@z", z);
            command.Parameters.AddWithValue("@x", x);
            command.Parameters.AddWithValue("@y", tmsY);

            using var reader = await command.ExecuteReaderAsync();
            if (await reader.ReadAsync())
            {
                var data = reader.GetStream(0);
                var bytes = new byte[data.Length];
                await data.ReadExactlyAsync(bytes);
                return bytes;
            }
        } catch (Exception ex) {
            _logger?.LogError(ex, "[Tiles] Error reading MBTiles at {Z}/{X}/{Y}", z, x, y);
        }

        return null;
    }

    public Task Broadcast(object message, string? targetClientId = null)
    {
        return _broadcast(message);
    }

    public void RunRepairJob()
    {
        string taskId = "library-repair";
        var cts = new CancellationTokenSource();
        _activeTasks.AddOrUpdate(taskId, cts, (k, old) => { old.Cancel(); return cts; });

        long runTimestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        _ = Task.Run(async () =>
        {
            try
            {
                // PHASE 1: Deduplicate Roots
                _logger.LogInformation("[Repair] Starting root deduplication (Timestamp: {Timestamp})...", runTimestamp);
                int deduped = _db.DeduplicateRoots();
                _logger.LogInformation("[Repair] Deduplication complete. Merged {Count} folders.", deduped);
                
                // Refresh UI immediately after folders are merged
                _ = _broadcast(new { type = "library.updated" });

                _logger.LogInformation("[Repair] Starting library structure verification (Producer-Consumer)...");
                
                // 1. Get ONLY top-level roots to avoid redundant recursive scans
                var topLevelRoots = _db.GetDirectoryTree().ToList();

                int totalProcessed = 0;
                int totalMoved = 0;
                var repairPathCache = new Dictionary<string, string>();

                // Shared channel for files to check
                var fileChannel = System.Threading.Channels.Channel.CreateBounded<(FileInfo Info, string RootId, string RootPath)>(new System.Threading.Channels.BoundedChannelOptions(1000) {
                    FullMode = System.Threading.Channels.BoundedChannelFullMode.Wait
                });

                // PRODUCER: Scans disk
                var producer = Task.Run(async () => {
                    try
                    {
                        var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true };
                        foreach (var root in topLevelRoots)
                        {
                            if (cts.Token.IsCancellationRequested) break;
                            string rootPath = _pathManager.Normalize(root.Path);
                            if (!Directory.Exists(rootPath)) continue;

                            _logger.LogInformation("[Repair-Producer] Starting recursive scan of base root: {Path}", rootPath);
                            
                            foreach (var physPath in Directory.EnumerateFiles(rootPath, "*", options))
                            {
                                if (cts.Token.IsCancellationRequested) break;
                                if (!TableConstants.SupportedExtensions.Contains(Path.GetExtension(physPath))) continue;
                                
                                await fileChannel.Writer.WriteAsync((new FileInfo(physPath), root.DirectoryId, rootPath), cts.Token);
                            }
                        }
                    }
                    catch (Exception ex) { _logger.LogError(ex, "[Repair-Producer] Error during disk scan"); }
                    finally { fileChannel.Writer.TryComplete(); }
                });

                // CONSUMER: Checks DB and Repairs
                _logger.LogInformation("[Repair-Consumer] Pre-loading file fingerprints from database...");
                var globalDbFiles = new Dictionary<(string name, long size, string date), List<string>>(); // Key -> List<FileEntryId>
                
                using (var preloadConn = new SqliteConnection($"Data Source={_db.DbPath}"))
                {
                    await preloadConn.OpenAsync();
                    using var cmd = preloadConn.CreateCommand();
                    cmd.CommandText = $"SELECT {TableConstants.Column.FileEntry.Id}, {TableConstants.Column.FileEntry.FileName}, {TableConstants.Column.FileEntry.Size}, {TableConstants.Column.FileEntry.CreatedAt}, {TableConstants.Column.FileEntry.RootPathId} FROM {TableConstants.TableName.FileEntry}";
                    using var reader = await cmd.ExecuteReaderAsync();
                    while (await reader.ReadAsync())
                    {
                        string id = reader.GetString(0);
                        string name = reader.GetString(1).ToLowerInvariant();
                        long size = reader.GetInt64(2);
                        string date = reader.GetString(3);
                        
                        var key = (name, size, date);
                        if (!globalDbFiles.TryGetValue(key, out var list))
                        {
                            list = new List<string>();
                            globalDbFiles[key] = list;
                        }
                        list.Add(id);
                    }
                }
                _logger.LogInformation("[Repair-Consumer] Loaded {Count} fingerprints.", globalDbFiles.Count);

                var pendingBatch = new List<(FileInfo Info, string RootId, string RootPath, List<string> FileIds)>();

                async Task ProcessBatch()
                {
                    if (pendingBatch.Count == 0) return;

                    await _db.ExecuteWriteAsync(async (connection, transaction) =>
                    {
                        foreach (var item in pendingBatch)
                        {
                            foreach (var fileId in item.FileIds)
                            {
                                string? currentRootId = null;
                                using (var checkCmd = connection.CreateCommand())
                                {
                                    checkCmd.Transaction = transaction;
                                    checkCmd.CommandText = $"SELECT {TableConstants.Column.FileEntry.RootPathId} FROM {TableConstants.TableName.FileEntry} WHERE {TableConstants.Column.FileEntry.Id} = $Id";
                                    checkCmd.Parameters.AddWithValue("$Id", fileId);
                                    currentRootId = checkCmd.ExecuteScalar() as string;
                                }

                                if (currentRootId == null) continue;

                                string physDir = _pathManager.Normalize(Path.GetDirectoryName(item.Info.FullName)!);
                                string expectedRootId = "";
                                bool moved = false;

                                try
                                {
                                    if (!repairPathCache.TryGetValue(physDir, out expectedRootId!))
                                    {
                                        expectedRootId = _db.GetOrCreateHierarchy(connection, transaction, item.RootId, item.RootPath, physDir);
                                        repairPathCache[physDir] = expectedRootId;
                                    }
                                    
                                    if (currentRootId != expectedRootId)
                                    {
                                        _logger.LogInformation("[Repair] FIXED: {Name} (Moved {Old} -> {New})", item.Info.Name, currentRootId, expectedRootId);
                                        _db.TouchFileWithRoot((SqliteConnection)connection, (SqliteTransaction)transaction!, fileId, expectedRootId, runTimestamp);
                                        Interlocked.Increment(ref totalMoved);
                                        moved = true;
                                    }
                                    else
                                    {
                                        _db.TouchFile((SqliteConnection)connection, (SqliteTransaction)transaction!, fileId, runTimestamp);
                                    }
                                }
                                catch (Exception ex)
                                {
                                    _logger.LogError(ex, "[Repair] Failed to process file {Id}", fileId);
                                }

                                int processed = Interlocked.Increment(ref totalProcessed);
                                if (processed % 100 == 0 || moved)
                                {
                                    _ = _broadcast(new { type = "repair.progress", repair_proc = processed, repair_mov = totalMoved });
                                }

                                if (processed % 1000 == 0)
                                {
                                    _ = _broadcast(new { type = "library.updated" });
                                }
                            }
                        }
                    });
                    pendingBatch.Clear();
                }

                await foreach (var item in fileChannel.Reader.ReadAllAsync(cts.Token))
                {
                    var info = item.Info;
                    var key = (info.Name.ToLowerInvariant(), info.Length, info.CreationTime.ToString("o"));

                    if (globalDbFiles.TryGetValue(key, out var ids))
                    {
                        pendingBatch.Add((item.Info, item.RootId, item.RootPath, ids));
                        if (pendingBatch.Count >= 100) // Small batches to keep UI responsive
                        {
                            await ProcessBatch();
                        }
                    }
                }

                await ProcessBatch(); // Final batch

                await producer; 

                _logger.LogInformation("[Repair] Job finished. Processed: {Processed}, Relocated: {Moved}", totalProcessed, totalMoved);
                
                _ = _broadcast(new { type = "repair.finished", repair_proc = totalProcessed, repair_mov = totalMoved });
                _ = _broadcast(new { type = "ui.notification", message = $"Repair finished: {deduped} folders merged, {totalMoved} files relocated.", status = "success" });
                _ = _broadcast(new { type = "library.updated" });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[Repair] Job failed");
                _ = _broadcast(new { type = "ui.notification", message = "Repair job failed.", status = "error" });
            }
            finally
            {
                _activeTasks.TryRemove(taskId, out _);
            }
        });
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
        return _db.GetPhotosPaged(req.limit ?? 100, req.offset ?? 0, req.rootId, req.pickedOnly ?? false, req.rating ?? 0, req.specificFileEntryIds);
    }

    public List<MetadataGroupResponse> GetMetadata(FileIdRequest req)
    {
        var flatMetadata = _db.GetMetadata(req.fileEntryId);
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
        var info = _db.GetLibraryInfo(_previewManager.DbPath, _configPath);
        info.IsIndexing = ImageIndexer.IsIndexing;
        info.IndexedCount = ImageIndexer.IndexedCount;
        info.TotalToIndex = ImageIndexer.TotalToIndex;
        info.TotalThumbnailedImages = _previewManager.GetTotalUniqueHashes();

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
            AddFile(_previewManager.DbPath, "previews.db");

            return new RpcResult<string>(fullPath);
        }
        catch (Exception ex)
        {
            return new RpcResult<string>(null, false, ex.Message);
        }
    }

    public async Task SetPicked(PickRequest req)
    {
        _db.SetPicked(req.fileEntryId, req.isPicked);
        await _broadcast(new { type = "photo.picked." + (req.isPicked ? "added" : "removed"), fileEntryId = req.fileEntryId });
    }

    public async Task SetRating(RateRequest req)
    {
        _db.SetRating(req.fileEntryId, req.rating);
        await _broadcast(new { type = "photo.starred.added", fileEntryId = req.fileEntryId, rating = req.rating });
    }

    public IEnumerable<string> Search(SearchRequest req)
    {
        return _db.Search(req);
    }

    public IEnumerable<CollectionResponse> GetCollections()
    {
        return _db.GetCollections();
    }

    public CollectionCreatedResponse CreateCollection(NameRequest req)
    {
        var id = _db.CreateCollection(req.name);
        return new CollectionCreatedResponse(id, req.name);
    }

    public void DeleteCollection(CollectionIdRequest req)
    {
        _db.DeleteCollection(req.collectionId);
    }

    public void AddFilesToCollection(CollectionAddRequest req)
    {
        _db.AddFilesToCollection(req.collectionId, req.fileEntryIds);
    }

    public IEnumerable<string> GetCollectionFiles(CollectionIdRequest req)
    {
        return _db.GetCollectionFiles(req.collectionId);
    }

    public void ClearPicked()
    {
        _db.ClearPicked();
    }

    public IEnumerable<string> GetPickedIds()
    {
        return _db.GetPickedIds();
    }

    public PagedMapPhotoResponse GetMapPhotos()
    {
        return _db.GetMapPhotos();
    }

    public PagedPhotosResponse GetGeotaggedPhotosPaged(PagedMapPhotosRequest req)
    {
        return _db.GetGeotaggedPhotosPaged(req.limit ?? 100, req.offset ?? 0);
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
                string abs = _pathManager.Normalize(path);
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

    public List<ScanFileResult> FindFiles(FindFilesRequest req)
    {
        if (string.IsNullOrEmpty(req.path)) return new List<ScanFileResult>();

        int limit = Math.Clamp(req.limit, 1, 50000);
        string path = req.path;
        string? targetRootId = req.targetRootId;
        string? template = req.template;
        var skipFiles = req.existingFiles != null ? new HashSet<string>(req.existingFiles, StringComparer.OrdinalIgnoreCase) : new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        string taskId = "fs-find-files";
        var cts = new CancellationTokenSource();
        _activeTasks.AddOrUpdate(taskId, cts, (k, old) => { old.Cancel(); return cts; });

        try
        {
            string absPath = _pathManager.Normalize(path);
            _logger.LogInformation("[FSFind] Scanning path: {AbsPath} (Limit: {Limit}, Skip: {SkipCount})", absPath, limit, skipFiles.Count);
            
            if (!Directory.Exists(absPath)) return new List<ScanFileResult>();

            string? absTargetRoot = null;
            if (!string.IsNullOrEmpty(targetRootId))
            {
                var tree = _db.GetDirectoryTree();
                var targetNode = FindNodeRecursive(tree, targetRootId);
                if (targetNode != null && !string.IsNullOrEmpty(targetNode.Path))
                {
                    absTargetRoot = _pathManager.Normalize(targetNode.Path);
                }
            }

            var foundFiles = new List<ScanFileResult>();
            var stack = new Stack<string>();
            stack.Push(absPath);

            var ignoredDirs = GetIgnoredDirectories();

            while (stack.Count > 0 && foundFiles.Count < limit)
            {
                if (cts.Token.IsCancellationRequested) break;
                string currentDir = stack.Pop();

                // Skip ignored directories
                if (ignoredDirs.Any(ignored => currentDir.StartsWith(ignored, StringComparison.OrdinalIgnoreCase)))
                {
                    _logger.LogDebug("[FSFind] Skipping ignored directory: {Dir}", currentDir);
                    continue;
                }

                try
                {
                    foreach (string dir in Directory.EnumerateDirectories(currentDir))
                    {
                        if (cts.Token.IsCancellationRequested) break;
                        var name = Path.GetFileName(dir);
                        if (!name.StartsWith(".")) stack.Push(dir);
                    }

                    foreach (string file in Directory.EnumerateFiles(currentDir))
                    {
                        if (cts.Token.IsCancellationRequested) break;
                        if (TableConstants.SupportedExtensions.Contains(Path.GetExtension(file)))
                        {
                            var relPath = _pathManager.GetRelativePath(absPath, file);
                            
                            // Optimization: Skip files we already have
                            if (skipFiles.Contains(relPath)) continue;

                            var dateTaken = GetDateTaken(file);
                            
                            bool exists = false;
                            if (absTargetRoot != null)
                            {
                                string fileName = Path.GetFileName(file);
                                string subDir = "";
                                if (!string.IsNullOrEmpty(template))
                                {
                                    subDir = template
                                        .Replace("{YYYY}", dateTaken.Year.ToString())
                                        .Replace("{MM}", dateTaken.Month.ToString("D2"))
                                        .Replace("{DD}", dateTaken.Day.ToString("D2"))
                                        .Replace("{Date}", dateTaken.ToString("yyyy-MM-dd"));
                                }
                                
                                string destPath = Path.Combine(absTargetRoot, subDir, fileName);
                                if (File.Exists(destPath)) exists = true;
                            }

                            foundFiles.Add(new ScanFileResult 
                            { 
                                Path = relPath, 
                                DateTaken = dateTaken,
                                Exists = exists
                            });
                            _ = _broadcast(new { type = "find-local.file-found", path = relPath, dateTaken = dateTaken, exists = exists });
                        }
                        if (foundFiles.Count >= limit) break;
                    }
                }
                catch (UnauthorizedAccessException) { /* Skip restricted dirs */ }
                catch (Exception ex) { _logger.LogDebug("[FSFind] Error in {Dir}: {Msg}", currentDir, ex.Message); }
            }

            return foundFiles;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[FSFind] Error scanning directory: {Path}", req.path);
            return new List<ScanFileResult>();
        }
        finally
        {
            _activeTasks.TryRemove(taskId, out _);
        }
    }

    public async Task<List<string>> FindNewFiles(NameRequest req)
    {
        if (string.IsNullOrEmpty(req.name)) return new List<string>();

        int limit = 1000;
        string path = req.name;
        if (path.Contains("|")) {
            var parts = path.Split('|');
            path = parts[0];
            int.TryParse(parts[1], out limit);
        }
        limit = Math.Clamp(limit, 1, 50000);

        string taskId = "fs-find-new-files";
        var cts = new CancellationTokenSource();
        _activeTasks.AddOrUpdate(taskId, cts, (k, old) => { old.Cancel(); return cts; });

        try
        {
            string absPath = _pathManager.Normalize(path);
            _logger.LogInformation("[FindNew] Scanning path: {Path} (Resolved: {AbsPath})", path, absPath);

            if (!Directory.Exists(absPath)) 
            {
                _logger.LogWarning("[FindNew] Directory does not exist: {AbsPath}", absPath);
                return new List<string>();
            }
            
            // Use optimized recursive enumeration
            var options = new EnumerationOptions { 
                IgnoreInaccessible = true, 
                RecurseSubdirectories = true,
                AttributesToSkip = FileAttributes.Hidden | FileAttributes.System 
            };

            var newFiles = new List<string>();
            var ignoredDirs = GetIgnoredDirectories();
            
            // Open shared connection for global existence check
            using var connection = new SqliteConnection($"Data Source={_db.DbPath}");
            await connection.OpenAsync();

            int checkedCount = 0;
            // Single recursive stream is much faster on SMB than manual BFS
            foreach (var file in Directory.EnumerateFiles(absPath, "*", options))
            {
                if (cts.Token.IsCancellationRequested) break;
                if (!TableConstants.SupportedExtensions.Contains(Path.GetExtension(file))) continue;

                // Check if file is in an ignored directory
                if (ignoredDirs.Any(ignored => file.StartsWith(ignored, StringComparison.OrdinalIgnoreCase))) continue;

                checkedCount++;
                var fullFile = _pathManager.Normalize(file);
                
                // Use global check to handle cases where file might be indexed under a different root branch
                if (!_db.FileExists(fullFile, connection))
                {
                    string relPath = _pathManager.GetRelativePath(absPath, fullFile);
                    newFiles.Add(relPath);
                    _ = _broadcast(new { type = "find-new.file-found", path = relPath });
                }
                
                if (newFiles.Count >= limit) break;
                if (checkedCount % 1000 == 0) _logger.LogDebug("[FindNew] Checked {Count} files...", checkedCount);
            }

            _logger.LogInformation("[FindNew] Finished. Checked {Checked} files, found {New} new.", checkedCount, newFiles.Count);
            return newFiles;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[FindNew] Error scanning directory: {Path}", path);
            return new List<string>();
        }
        finally
        {
            _activeTasks.TryRemove(taskId, out _);
        }
    }

    private DirectoryNodeResponse? FindNodeRecursive(IEnumerable<DirectoryNodeResponse> nodes, string id)
    {
        foreach (var node in nodes)
        {
            if (node.DirectoryId == id) return node;
            var found = FindNodeRecursive(node.Children, id);
            if (found != null) return found;
        }
        return null;
    }

    public ValidateImportResponse ValidateImport(ValidateImportRequest req)
    {
        Console.WriteLine($"[Validate] Request for RootId: {req.targetRootId}");
        var tree = _db.GetDirectoryTree();
        var root = FindNodeRecursive(tree, req.targetRootId);

        if (root == null)
        {
             Console.WriteLine($"[Validate] Target root {req.targetRootId} NOT FOUND in directory tree.");
             return new ValidateImportResponse();
        }
        
        if (string.IsNullOrEmpty(root.Path))
        {
             Console.WriteLine("[Validate] Root path is empty.");
             return new ValidateImportResponse();
        }

        string absRoot = _pathManager.Normalize(root.Path);
        Console.WriteLine($"[Validate] Checking {req.items.Count} items in {absRoot}");
        
        var existing = new HashSet<string>(); 
        var itemsToCheck = new List<KeyValuePair<string, string>>();
        
        _logger?.LogInformation("[Validate] Checking {Count} items in {Root}", req.items.Count, absRoot);

        // 1. Direct path check (Fast)
        foreach (var kvp in req.items)
        {
            try
            {
                // Normalize separators
                string relPath = kvp.Value.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
                string destPath = Path.Combine(absRoot, relPath);
                
                if (File.Exists(destPath)) 
                {
                    existing.Add(kvp.Key);
                    _ = _broadcast(new { type = "import.validation-result", path = kvp.Key, exists = true });
                }
                else 
                {
                    itemsToCheck.Add(new KeyValuePair<string, string>(kvp.Key, relPath));
                }
            }
            catch { }
        }

        // 2. Scoped Recursive Check (Slower but catches moved files on disk even if not indexed)
        // Group remaining items by their top-level folder to minimize scanning
        if (itemsToCheck.Any())
        {
            var groups = itemsToCheck.GroupBy(k => {
                var parts = k.Value.Split(Path.DirectorySeparatorChar);
                return parts.Length > 1 ? parts[0] : "";
            });

            foreach (var group in groups)
            {
                string subFolder = group.Key;
                string searchRoot = string.IsNullOrEmpty(subFolder) ? absRoot : Path.Combine(absRoot, subFolder);
                
                if (Directory.Exists(searchRoot))
                {
                    try
                    {
                        // Scan filenames in this subtree
                        var foundNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        var opts = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true };
                        
                        _logger?.LogInformation("[Validate] Scanning subtree: {Path}", searchRoot);
                        Console.WriteLine($"[Validate] Scanning subtree: {searchRoot}");
                        
                        int scanned = 0;
                        foreach(var f in Directory.EnumerateFiles(searchRoot, "*", opts))
                        {
                            foundNames.Add(Path.GetFileName(f));
                            scanned++;
                        }
                        
                        _logger?.LogInformation("[Validate] Scanned {Count} files in {Path}. First 5: {Sample}", scanned, subFolder, string.Join(", ", foundNames.Take(5)));
                        Console.WriteLine($"[Validate] Scanned {scanned} files in {subFolder}. First 5: {string.Join(", ", foundNames.Take(5))}");

                        foreach(var item in group)
                        {
                            string fileName = Path.GetFileName(item.Value);
                            if (foundNames.Contains(fileName)) 
                            {
                                existing.Add(item.Key);
                                _ = _broadcast(new { type = "import.validation-result", path = item.Key, exists = true });
                            }
                            else if (scanned > 0 && scanned < 50) // Debug small scans
                            {
                                _logger?.LogDebug("[Validate] Checked {Name} against {Count} files - Not found.", fileName, foundNames.Count);
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger?.LogWarning(ex, "[Validate] Error scanning {Path}", searchRoot);
                    }
                }
                else
                {
                    _logger?.LogWarning("[Validate] Search root does not exist: {Path}", searchRoot);
                }
            }
        }

        _logger?.LogInformation("[Validate] Found {Count} existing files total.", existing.Count);
        return new ValidateImportResponse { ExistingSourceFiles = existing.ToList() };
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

                IImageIndexer indexer = new ImageIndexer((DatabaseManager)_db, _loggerFactory.CreateLogger<ImageIndexer>(), (PreviewManager)_previewManager, sizes.ToArray());
                indexer.RegisterFileProcessedHandler((id, path) => 
                {
                    _logger?.LogDebug("[BATCH] Broadcast file.imported for {Path}", path);
                    string? fileRootId = _db.GetFileRootId(id);
                    _ = _broadcast(new { type = "file.imported", fileEntryId = id, path, rootId = fileRootId });
                });
                
                string absRoot = _pathManager.Normalize(req.rootPath);
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

    public string ImportLocal(ImportLocalRequest req)
    {
        if (req.sourceFiles == null || req.sourceFiles.Length == 0) return "";

        string taskId = $"import-local-{Guid.NewGuid()}";
        var cts = new CancellationTokenSource();
        var token = cts.Token; // CAPTURE TOKEN LOCALLY
        if (!_activeTasks.TryAdd(taskId, cts)) return "";

        _ = Task.Run(async () =>
        {
            try
            {
                _logger?.LogInformation("[IMPORT] TASK START {Id}: Processing {Count} files with Pipelining.", taskId, req.sourceFiles.Length);
                ImageIndexer.SetProgress(true, 0, req.sourceFiles.Length);

                var tree = _db.GetDirectoryTree();
                var targetRoot = FindNodeRecursive(tree, req.targetRootId);
                if (targetRoot == null) { _logger?.LogError("[IMPORT] Target root not found: {Id}", req.targetRootId); return; }

                string absTargetRoot = _pathManager.Normalize(targetRoot.Path!);
                string absSourceRoot = _pathManager.Normalize(req.sourceRoot);
                var sizes = new List<int>();
                if (req.generatePreview) { sizes.Add(300); sizes.Add(1024); }

                IImageIndexer indexer = new ImageIndexer((DatabaseManager)_db, _loggerFactory.CreateLogger<ImageIndexer>(), (PreviewManager)_previewManager, sizes.ToArray());
                var filesToCleanup = new ConcurrentBag<string>();

                // Channel for items ready to be processed and then committed
                var copyChannel = System.Threading.Channels.Channel.CreateBounded<(string src, string dst, string rel, ProcessedFileData fileData)>(new System.Threading.Channels.BoundedChannelOptions(5) {
                    FullMode = System.Threading.Channels.BoundedChannelFullMode.Wait
                });

                // Open a shared connection for hierarchy resolution to avoid repeated overhead
                using var sharedConn = new SqliteConnection($"Data Source={_db.DbPath}");
                await sharedConn.OpenAsync(token);

                // STAGE 1: Producer (Hierarchy, Hash, Metadata, Previews) - RUNS WITHOUT DB LOCK
                var processingTask = Task.Run(async () => {
                    try {
                        foreach (var sourceFile in req.sourceFiles)
                        {
                            if (token.IsCancellationRequested) break;
                            try
                            {
                                string absSource = Path.Combine(absSourceRoot, sourceFile);
                                if (!File.Exists(absSource)) {
                                    _ = _broadcast(new { type = "import.file.finished", taskId, sourcePath = sourceFile, success = false, error = "File not found" });
                                    continue;
                                }

                                DateTime dateTaken = GetDateTaken(absSource);
                                string subDir = req.directoryTemplate
                                    .Replace("{YYYY}", dateTaken.Year.ToString())
                                    .Replace("{MM}", dateTaken.Month.ToString("D2"))
                                    .Replace("{DD}", dateTaken.Day.ToString("D2"))
                                    .Replace("{Date}", dateTaken.ToString("yyyy-MM-dd"));

                                string targetDir = Path.Combine(absTargetRoot, subDir);
                                Directory.CreateDirectory(targetDir);
                                string targetPath = Path.Combine(targetDir, Path.GetFileName(absSource));

                                if (req.preventDuplicateName && File.Exists(targetPath)) {
                                    _ = _broadcast(new { type = "import.file.finished", taskId, sourcePath = sourceFile, success = false, error = "Skipped (Duplicate Name)" });
                                    continue;
                                }

                                // 1. Ensure the hierarchy exists in the database first so we get the correct RootPathId
                                string targetDirPath = _pathManager.GetDirectoryPath(targetPath);
                                using var trans = sharedConn.BeginTransaction();
                                string actualRootId = _db.GetOrCreateHierarchy(sharedConn, trans, req.targetRootId, absTargetRoot, targetDirPath);
                                trans.Commit();

                                _ = _broadcast(new { type = "import.file.progress", taskId, sourcePath = sourceFile, status = "thumbnailing", percent = 10 });
                                
                                // 2. ALL HEAVY WORK HAPPENS HERE (No lock held)
                                var fileData = indexer.PrepareFileData(new FileInfo(absSource), targetPath, actualRootId, null, req.preventDuplicateHash);

                                if (req.preventDuplicateHash && _db.FileExistsByHashWithConnection(sharedConn, null, fileData.Entry.Hash!)) {
                                    _ = _broadcast(new { type = "import.file.finished", taskId, sourcePath = sourceFile, success = false, error = "Skipped (Duplicate Hash)" });
                                    continue;
                                }

                                // Signal that processing is done and it's waiting for its turn in the copy queue
                                _ = _broadcast(new { type = "import.file.progress", taskId, sourcePath = sourceFile, status = "queued", percent = 40 });

                                await copyChannel.Writer.WriteAsync((absSource, targetPath, sourceFile, fileData), token);
                            }
                            catch (OperationCanceledException) { break; }
                            catch (Exception ex) {
                                string errorMsg = ex.Message;
                                if (ex.Message.Contains("Input/output error", StringComparison.OrdinalIgnoreCase)) {
                                    errorMsg = "Disk Read Error (Hardware/Drive Failure)";
                                    _logger?.LogCritical("[IMPORT] HARDWARE ERROR processing {File}: {Msg}", sourceFile, ex.Message);
                                }
                                _logger?.LogError(ex, "[IMPORT] Processing failed for {File}", sourceFile);
                                _ = _broadcast(new { type = "import.file.finished", taskId, sourcePath = sourceFile, success = false, error = errorMsg });
                            }
                        }
                    } 
                    catch (OperationCanceledException) { }
                    catch (ObjectDisposedException) { }
                    finally {
                        copyChannel.Writer.TryComplete();
                    }
                });

                // STAGE 2: Consumer (Commit DB and then Copy)
                int count = 0;
                try 
                {
                    await foreach (var (src, dst, rel, fileData) in copyChannel.Reader.ReadAllAsync(token))
                    {
                        try {
                            await _db.ExecuteWriteAsync(async (dbConn, transaction) => {
                                _ = _broadcast(new { type = "import.file.progress", taskId, sourcePath = rel, status = "indexing", percent = 50 });
                                
                                // Hierarchy was already resolved in Stage 1, but we pass it anyway to ensure consistency
                                indexer.CommitFileDataWithConnection(dbConn, transaction, fileData, dst, absTargetRoot, req.targetRootId);
                                await Task.CompletedTask;
                            });

                            _ = _broadcast(new { type = "import.file.progress", taskId, sourcePath = rel, status = "copying", percent = 80 });
                            filesToCleanup.Add(dst);

                            using (var sourceStream = new FileStream(src, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, true))
                            using (var destStream = new FileStream(dst, FileMode.Create, FileAccess.Write, FileShare.None, 4096, true))
                            {
                                await sourceStream.CopyToAsync(destStream, 1024 * 1024, token);
                            }

                            _ = _broadcast(new { type = "file.imported", fileEntryId = fileData.Entry.Id, path = dst, rootId = fileData.Entry.RootPathId });
                            _ = _broadcast(new { type = "import.file.finished", taskId, sourcePath = rel, targetPath = dst, fileEntryId = fileData.Entry.Id, success = true });
                            
                            count++;
                            ImageIndexer.SetProgress(true, count, req.sourceFiles.Length);
                        }
                        catch (OperationCanceledException) { break; }
                        catch (ObjectDisposedException) { break; }
                        catch (Exception ex) {
                            string errorMsg = ex.Message;
                            if (ex.Message.Contains("Input/output error", StringComparison.OrdinalIgnoreCase)) {
                                errorMsg = "Disk Read Error (Hardware/Drive Failure)";
                                _logger?.LogCritical("[IMPORT] HARDWARE ERROR reading {File}: {Msg}", rel, ex.Message);
                            }

                            // Cleanup: Copy failed, so the DB entry is now invalid.
                            await _db.ExecuteWriteAsync(async (conn, trans) => {
                                _logger?.LogWarning("[IMPORT] Copy failed for {File}. Rolling back DB entry {Id}.", dst, fileData.Entry.Id);
                                _db.DeleteFileEntryWithConnection(conn, trans, fileData.Entry.Id);
                                await Task.CompletedTask;
                            });

                            try { if (File.Exists(dst)) File.Delete(dst); } catch { }
                            _ = _broadcast(new { type = "import.file.finished", taskId, sourcePath = rel, success = false, error = errorMsg });
                        }

                        // Small yield to let other tasks breathe
                        await Task.Delay(10, token);
                    }
                }
                catch (OperationCanceledException) { /* Handled below */ }
                catch (ObjectDisposedException) { /* Handled below */ }
                catch (Exception ex) { _logger?.LogError(ex, "[IMPORT] Consumer error"); }

                if (token.IsCancellationRequested)
                {
                    _logger?.LogInformation("[IMPORT] STOPPED {Id}.", taskId);
                    _ = _broadcast(new { type = "import.stopped", taskId });
                    _ = _broadcast(new { type = "ui.notification", message = "Import stopped", status = "info" });
                }

                await processingTask;
                await _broadcast(new { type = "scan.finished" });
            }
            catch (OperationCanceledException) { }
            catch (ObjectDisposedException) { }
            catch (Exception ex) { _logger?.LogCritical(ex, "[IMPORT] CRITICAL FAILURE {Id}", taskId); }
            finally {
                ImageIndexer.SetProgress(false, 0, 0);
                _activeTasks.TryRemove(taskId, out _);
            }
        });

        return taskId;
    }

    private DateTime GetDateTaken(string path)
    {
        try
        {
            var directories = MetadataExtractor.ImageMetadataReader.ReadMetadata(path);
            
            // 1. Try Exif SubIFD (Most common for Date Taken)
            var subIfd = directories.OfType<MetadataExtractor.Formats.Exif.ExifSubIfdDirectory>().FirstOrDefault();
            if (subIfd != null)
            {
                if (subIfd.TryGetDateTime(MetadataExtractor.Formats.Exif.ExifDirectoryBase.TagDateTimeOriginal, out var dt)) return dt;
                if (subIfd.TryGetDateTime(MetadataExtractor.Formats.Exif.ExifDirectoryBase.TagDateTimeDigitized, out var dt2)) return dt2;
            }

            // 2. Fallback: Search all directories for common date tags
            foreach (var dir in directories)
            {
                // 0x9003: DateTimeOriginal, 0x9004: DateTimeDigitized, 0x0132: DateTime
                if (dir.TryGetDateTime(0x9003, out var d1)) return d1;
                if (dir.TryGetDateTime(0x9004, out var d2)) return d2;
                if (dir.TryGetDateTime(0x0132, out var d3)) return d3;
            }
        }
        catch { }
        
        // Fallback to file system dates (prefer oldest to approximate creation)
        try {
            var creation = File.GetCreationTime(path);
            var modified = File.GetLastWriteTime(path);
            return creation < modified ? creation : modified;
        } catch { return DateTime.Now; }
    }

    public void GenerateThumbnails(GenerateThumbnailsRequest req, Action<ImageRequest, CancellationToken>? enqueue = null)
    {
        _logger.LogInformation("[API] Generate Thumbnails requested for root {RootId} (Recursive: {Recursive}, Force: {Force}, StackedOnly: {StackedOnly}, ExtensionFilter: {ExtensionFilter})", 
            req.rootId, req.recursive, req.force, req.stackedOnly, req.extensionFilter);

        var finalEnqueue = enqueue ?? ((r, ct) => _ = GetImageAsync(r, ct));

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
                var fileIds = req.stackedOnly 
                    ? _db.GetStackedFileIdsUnderRoot(req.rootId, req.recursive)
                    : _db.GetFileIdsUnderRoot(req.rootId, req.recursive);

                int total = fileIds.Count;
                int processed = 0;
                int thumbnailed = 0;
                _logger?.LogInformation("Enqueuing background thumbnail generation for {Total} candidate files in root {RootId}", total, req.rootId);

                _ = _broadcast(new { type = "folder.progress", rootId = req.rootId, processed = 0, total, thumbnailed = 0 });

                foreach (var fId in fileIds)
                {
                    if (cts.Token.IsCancellationRequested) break;
                    processed++;

                    if (!string.IsNullOrEmpty(req.extensionFilter))
                    {
                        string? path = _db.GetFullFilePath(fId);
                        if (path == null || !path.EndsWith(req.extensionFilter, StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }
                    }
                    
                    string? hash = _db.GetFileHash(fId);
                    bool alreadyExists = hash != null && _previewManager.HasPreview(hash, 300) && _previewManager.HasPreview(hash, 1024);

                    if (alreadyExists && !req.force)
                    {
                        thumbnailed++;
                        string shortId = fId.Length > 12 ? $"{fId.Substring(0, 4)}...{fId.Substring(fId.Length - 4)}" : fId;
                        _logger?.LogInformation("[THUMB] {Id,-11} | Priority: {Priority,12:F4} | Tot: {Total,9:F1}ms | SKIPPED (Exists)",
                            shortId, -1000.0, 0.0);
                    }
                    else
                    {
                        if (req.force && hash != null)
                        {
                            _previewManager.DeletePreviewsByHash(hash);
                        }
                        finalEnqueue(new ImageRequest { fileEntryId = fId, size = 300, requestId = -1, priority = -1000 }, cts.Token);
                        finalEnqueue(new ImageRequest { fileEntryId = fId, size = 1024, requestId = -1, priority = -1001 }, cts.Token);
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

    public void ForceUpdatePreview(ForceUpdatePreviewRequest req, Action<ImageRequest, CancellationToken>? enqueue = null)
    {
        string? hash = _db.GetFileHash(req.fileEntryId);
        if (hash != null)
        {
            _previewManager.DeletePreviewsByHash(hash);
        }

        var finalEnqueue = enqueue ?? ((r, ct) => _ = GetImageAsync(r, ct));
        
        finalEnqueue(new ImageRequest { fileEntryId = req.fileEntryId, size = 300, requestId = -1, priority = 100 }, CancellationToken.None);
        finalEnqueue(new ImageRequest { fileEntryId = req.fileEntryId, size = 1024, requestId = -1, priority = 90 }, CancellationToken.None);
    }

    public void ForgetRoot(ForgetRootRequest req)
    {
        if (string.IsNullOrEmpty(req.rootId)) return;

        try
        {
            if (!req.keepPreviews)
            {
                var hashes = _db.GetFileHashesUnderRoot(req.rootId);
                _logger?.LogInformation("Deleting previews for {Count} unique hashes in root {RootId}", hashes.Count, req.rootId);
                foreach (var hash in hashes)
                {
                    _previewManager.DeletePreviewsByHash(hash);
                }
            }

            _db.ForgetRoot(req.rootId);
            _ = _broadcast(new { type = "library.updated" });
            _ = _broadcast(new { type = "scan.finished" });
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "Error forgetting root {RootId}", req.rootId);
        }
    }

    public bool CancelTask(TaskRequest req)
    {
        if (_activeTasks.TryRemove(req.taskId, out var cts))
        {
            cts.Cancel();
            // Don't dispose immediately, let the Task catch the cancellation and finish gracefully
            _ = Task.Delay(2000).ContinueWith(_ => cts.Dispose());
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
        if (!_exportCache.TryRemove(token, out var req) || req.fileEntryIds == null) return;
        
        _logger.LogInformation("[EXPORT] Starting export for {Count} files", req.fileEntryIds.Length);

        using (var archive = new ZipArchive(outputStream, ZipArchiveMode.Create, leaveOpen: true))
        {
            var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var id in req.fileEntryIds)
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

    public PhysicalFileResult? DownloadFile(string fileEntryId)
    {
        string? fullPath = _db.GetFullFilePath(fileEntryId);
        if (fullPath == null || !File.Exists(fullPath)) return null;
        return new PhysicalFileResult(fullPath, Path.GetFileName(fullPath));
    }

    private HashSet<string> GetIgnoredDirectories()
    {
        var ignoredJson = _db.GetSetting("ignored-directories");
        if (string.IsNullOrEmpty(ignoredJson)) return new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var list = JsonSerializer.Deserialize<List<string>>(ignoredJson);
            return new HashSet<string>(list ?? new List<string>(), StringComparer.OrdinalIgnoreCase);
        }
        catch { return new HashSet<string>(StringComparer.OrdinalIgnoreCase); }
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