using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Data.Sqlite;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.IO.Compression;
using System.Collections.Concurrent;
using System.Linq;
using System.Diagnostics;
using ImageMagick;

namespace PhotoLibrary
{
    // REQ-ARCH-00004
    public static class WebServer
    {
        private static readonly ConcurrentDictionary<string, ZipRequest> _exportCache = new();
        private static readonly ConcurrentBag<(WebSocket socket, SemaphoreSlim lockobj, string clientId)> _activeSockets = new();
        private static readonly ConcurrentDictionary<string, CancellationTokenSource> _activeTasks = new();
        private static ILogger? _logger;
        private static readonly Process _currentProcess = Process.GetCurrentProcess();

        private class QueuedImageRequest
        {
            public ImageRequest Request { get; }
            public WebSocket? Socket { get; }
            public SemaphoreSlim? Lock { get; }
            public TaskCompletionSource<byte[]>? Tcs { get; }
            public CancellationToken ct { get; }
            public long StartTime { get; }
            public double Priority { get; }
            
            public double QueueMs { get; set; }
            public double RetrievalMs { get; set; }
            public double GeneratingMs { get; set; }
            public byte[]? Payload { get; set; }

            public QueuedImageRequest(ImageRequest request, WebSocket? socket, SemaphoreSlim? lockobj, TaskCompletionSource<byte[]>? tcs, CancellationToken ct, long startTime, double priority)
            {
                Request = request; Socket = socket; Lock = lockobj; Tcs = tcs; this.ct = ct; StartTime = startTime; Priority = priority;
            }
        }

        private static readonly PriorityQueue<QueuedImageRequest, double> _requestQueue = new();
        private static readonly SemaphoreSlim _queueSemaphore = new(0);
        private static readonly object _queueLock = new();
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _fileLocks = new();
        private static readonly ConcurrentDictionary<(WebSocket, int), TaskCompletionSource<byte[]>> _pendingTaskSources = new();
        private static int _activeMagickTasks = 0;

        public static void Start(int port, DatabaseManager dbManager, PreviewManager previewManager, CameraManager cameraManager, ILoggerFactory loggerFactory, string bindAddr = "localhost", string configPath = "")
        {
            _logger = loggerFactory.CreateLogger("WebServer");

            _logger.LogInformation("ImageMagick Resource Limits: Memory={Mem}MB, Area={Area}MB", 
                ResourceLimits.Memory / 1024 / 1024,
                ResourceLimits.Area / 1024 / 1024);

            // Periodically log memory usage
            _ = Task.Run(async () => {
                while (true) {
                    await Task.Delay(10000);
                    _currentProcess.Refresh();
                    long workingSet = _currentProcess.WorkingSet64 / 1024 / 1024;
                    long privateBytes = _currentProcess.PrivateMemorySize64 / 1024 / 1024;
                    _logger?.LogInformation("[MONITOR] Memory: WorkingSet={WS}MB, Private={Private}MB, ActiveMagick={Active}", workingSet, privateBytes, _activeMagickTasks);
                }
            });

            // Start Background Workers for Image Processing
            int workerCount = Math.Max(1, Environment.ProcessorCount / 2);
            _logger?.LogInformation("Starting {Count} background image worker threads.", workerCount);
            for (int i = 0; i < workerCount; i++)
            {
                StartImageWorker(dbManager, previewManager);
            }

            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.Logging.AddProvider(new LoggerProviderProxy(loggerFactory));

            builder.WebHost.UseUrls($"http://{bindAddr}:{port}");
            builder.Services.Configure<HostOptions>(opts => opts.ShutdownTimeout = TimeSpan.FromSeconds(2));

            builder.Services.AddSingleton(dbManager);
            builder.Services.AddSingleton(previewManager);
            builder.Services.AddSingleton(cameraManager);
            builder.Services.AddSingleton(loggerFactory);

            var app = builder.Build();
            var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
            app.UseWebSockets();

            dbManager.OnFolderCreated += (id, name) => {
                _ = Broadcast(new { type = "folder.created", id, name });
            };

            // --- API Endpoints ---
            // REQ-ARCH-00007

            app.MapGet("/api/camera/thumbnail/{model}", (string model, CameraManager cm) =>
            {
                var data = cm.GetCameraThumbnail(model);
                if (data == null) return Results.NotFound();
                return Results.Bytes(data, "image/webp"); 
            });

            app.MapPost("/api/photos", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<PagedPhotosRequest>();
                if (req == null) return Results.BadRequest();
                var response = db.GetPhotosPaged(req.limit ?? 100, req.offset ?? 0, req.rootId, req.pickedOnly ?? false, req.rating ?? 0, req.specificIds);
                return Results.Ok(response);
            });

            app.MapPost("/api/metadata", (IdRequest req, DatabaseManager db) =>
            {
                var flatMetadata = db.GetMetadata(req.id);
                var grouped = flatMetadata
                    .GroupBy(m => m.Directory ?? "General")
                    .Select(g => new MetadataGroupResponse
                    {
                        Name = g.Key,
                        Items = g.GroupBy(i => i.Tag ?? "")
                                 .ToDictionary(tg => tg.Key, tg => tg.First().Value ?? "")
                    })
                    .ToList();
                return Results.Ok(grouped);
            });

            app.MapPost("/api/directories", (DatabaseManager db) =>
            {
                return Results.Ok(db.GetDirectoryTree());
            });

            app.MapPost("/api/library/info", (DatabaseManager db, PreviewManager pm) =>
            {
                var info = db.GetLibraryInfo(pm.DbPath, configPath);
                info.IsIndexing = ImageIndexer.IsIndexing;
                info.IndexedCount = ImageIndexer.IndexedCount;
                info.TotalToIndex = ImageIndexer.TotalToIndex;
                info.TotalThumbnailedImages = pm.GetTotalUniqueHashes();
                return Results.Ok(info);
            });

            app.MapPost("/api/pick", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<PickRequest>();
                if (req == null) return Results.BadRequest();
                db.SetPicked(req.id, req.isPicked);
                _ = Broadcast(new { type = "photo.picked." + (req.isPicked ? "added" : "removed"), id = req.id });
                return Results.Ok(new { });
            });

            app.MapPost("/api/rate", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<RateRequest>();
                if (req == null) return Results.BadRequest();
                db.SetRating(req.id, req.rating);
                _ = Broadcast(new { type = "photo.starred.added", id = req.id, rating = req.rating });
                return Results.Ok(new { });
            });

            app.MapPost("/api/search", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<SearchRequest>();
                if (req == null) return Results.BadRequest();
                return Results.Ok(db.Search(req));
            });

            app.MapPost("/api/collections/list", (DatabaseManager db) =>
            {
                var list = db.GetCollections().Select(c => new { id = c.Id, name = c.Name, count = c.Count });
                return Results.Ok(list);
            });

            app.MapPost("/api/collections/create", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<NameRequest>();
                if (req == null) return Results.BadRequest();
                var id = db.CreateCollection(req.name);
                return Results.Ok(new { id, name = req.name });
            });

            app.MapPost("/api/collections/delete", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<IdRequest>();
                if (req == null) return Results.BadRequest();
                db.DeleteCollection(req.id);
                return Results.Ok(new { });
            });

            app.MapPost("/api/collections/add-files", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<CollectionAddRequest>();
                if (req == null) return Results.BadRequest();
                db.AddFilesToCollection(req.collectionId, req.fileIds);
                return Results.Ok(new { });
            });

            app.MapPost("/api/collections/get-files", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<IdRequest>();
                if (req == null) return Results.BadRequest();
                var fileIds = db.GetCollectionFiles(req.id);
                return Results.Ok(fileIds);
            });

            app.MapPost("/api/picked/clear", (DatabaseManager db) =>
            {
                db.ClearPicked();
                return Results.Ok(new { });
            });

            app.MapPost("/api/picked/ids", (DatabaseManager db) =>
            {
                return Results.Ok(db.GetPickedIds());
            });

            app.MapPost("/api/stats", (DatabaseManager db) =>
            {
                return Results.Ok(db.GetGlobalStats());
            });

            app.MapPost("/api/fs/list", (NameRequest req, ILoggerFactory logFact) =>
            {
                var logger = logFact.CreateLogger("FSList");
                string path = req?.name ?? "";
                
                try 
                {
                    IEnumerable<string> dirs;
                    if (string.IsNullOrEmpty(path))
                    {
                        if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                            dirs = DriveInfo.GetDrives().Select(d => d.Name);
                        else
                            dirs = new[] { "/" };
                    }
                    else
                    {
                        string abs = PathUtils.ResolvePath(path);
                        if (!Directory.Exists(abs)) return Results.NotFound();
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
                    
                    var result = dirs.OrderBy(d => d).Select(d => {
                        string name = Path.GetFileName(d);
                        if (string.IsNullOrEmpty(name)) name = d; 
                        return new DirectoryResponse { 
                            Path = d, 
                            Name = name
                        };
                    });
                    
                    return Results.Ok(result.ToList());
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "[FS] Error listing directory: {Path}", path);
                    return Results.Ok(Array.Empty<DirectoryResponse>());
                }
            });

            app.MapPost("/api/fs/find-files", (NameRequest req, ILoggerFactory logFact) =>
            {
                var logger = logFact.CreateLogger("FSFind");
                if (string.IsNullOrEmpty(req.name)) return Results.BadRequest();
                try
                {
                    string absPath = PathUtils.ResolvePath(req.name);
                    logger.LogInformation("[FSFind] Scanning path: {AbsPath}", absPath);
                    
                    if (!Directory.Exists(absPath)) 
                    {
                        logger.LogWarning("[FSFind] Directory does not exist: {AbsPath}", absPath);
                        return Results.NotFound();
                    }

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
                        catch (Exception ex) { logger.LogDebug("[FSFind] Error in {Dir}: {Msg}", currentDir, ex.Message); }
                    }

                    logger.LogInformation("[FSFind] Found {Count} supported files in {AbsPath}", foundFiles.Count, absPath);
                    return Results.Ok(new { files = foundFiles });
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "[FSFind] Error scanning directory: {Path}", req.name);
                    return Results.BadRequest(new { error = ex.Message });
                }
            });

            app.MapPost("/api/library/find-new-files", (NameRequest req, DatabaseManager db) =>
            {
                if (string.IsNullOrEmpty(req.name)) return Results.BadRequest();

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
                    if (!Directory.Exists(absPath)) {
                        _logger?.LogDebug("Directory not found: {AbsPath}", absPath);
                        return Results.Ok(new { files = Array.Empty<string>() });
                    }
                    
                    var enumerator = Directory.EnumerateFiles(absPath, "*", SearchOption.AllDirectories)
                        .Where(f => TableConstants.SupportedExtensions.Contains(Path.GetExtension(f)));

                    var newFiles = new List<string>();
                    using var connection = new SqliteConnection($"Data Source={db.DbPath}");
                    connection.Open();

                    foreach (var file in enumerator)
                    {
                        var fullFile = Path.GetFullPath(file);
                        if (!db.FileExists(fullFile, connection))
                        {
                            newFiles.Add(Path.GetRelativePath(absPath, fullFile));
                        }
                        if (newFiles.Count >= limit) break;
                    }
                    
                    return Results.Ok(new { files = newFiles });
                }
                catch (Exception ex)
                {
                    return Results.BadRequest(new { error = ex.Message });
                }
            });

            app.MapPost("/api/library/import-batch", (ImportBatchRequest req, DatabaseManager db, PreviewManager pm, ILoggerFactory logFact) =>
            {
                if (req.relativePaths == null) return Results.BadRequest();

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

                        var indexer = new ImageIndexer(db, logFact.CreateLogger<ImageIndexer>(), pm, sizes.ToArray());
                        indexer.OnFileProcessed += (id, path) => 
                        {
                            string? fileRootId = db.GetFileRootId(id);
                            _ = Broadcast(new { type = "file.imported", id, path, rootId = fileRootId });
                        };
                        
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
                        await Broadcast(new { type = "scan.finished" });
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

                return Results.Ok();
            });

            app.MapPost("/api/library/generate-thumbnails", (GenerateThumbnailsRequest req, DatabaseManager db, PreviewManager pm, ILoggerFactory logFact) =>
            {
                Console.WriteLine($"[API] Generate Thumbnails requested for root {req.rootId} (Recursive: {req.recursive})");

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
                        var fileIds = db.GetFileIdsUnderRoot(req.rootId, req.recursive);
                        int total = fileIds.Count;
                        int processed = 0;
                        int thumbnailed = 0;
                        _logger?.LogInformation("Enqueuing background thumbnail generation for {Total} files in root {RootId}", total, req.rootId);

                        // Initial progress report
                        _ = Broadcast(new { type = "folder.progress", rootId = req.rootId, processed = 0, total, thumbnailed = 0 });

                        foreach (var fId in fileIds)
                        {
                            if (cts.Token.IsCancellationRequested) break;

                            processed++;
                            
                            // Check if work is actually needed before enqueuing to queue
                            string? hash = db.GetFileHash(fId);
                            if (hash != null && pm.HasPreview(hash, 300) && pm.HasPreview(hash, 1024))
                            {
                                thumbnailed++;
                            }
                            else
                            {
                                // Enqueue into the SAME priority queue as UI, but with very low priority
                                lock (_queueLock)
                                {
                                    var imgReq = new ImageRequest { fileId = fId, size = 300, requestId = -1, priority = -1000 };
                                    var qReq = new QueuedImageRequest(imgReq, null, null, null, cts.Token, Stopwatch.GetTimestamp(), -1000);
                                    _requestQueue.Enqueue(qReq, 1000); // PriorityQueue is min-priority, so higher value = processed later
                                }
                                _queueSemaphore.Release();
                            }

                            if (processed % 50 == 0 || processed == total)
                            {
                                _ = Broadcast(new { 
                                    type = "folder.progress", 
                                    rootId = req.rootId, 
                                    processed, 
                                    total,
                                    thumbnailed 
                                });
                            }
                        }
                        
                        _logger?.LogInformation("Finished enqueuing background tasks for root {RootId}.", req.rootId);
                        // Note: actual completion of individual files is handled by the workers broadcasting preview.generated
                    }
                    catch (Exception ex) { _logger?.LogError(ex, "[WS] Background thumbnail enqueue error"); }
                    finally { _activeTasks.TryRemove(taskId, out _); }
                });

                return Results.Ok();
            });

            app.MapPost("/api/library/set-annotation", (FolderAnnotationRequest req, DatabaseManager db) =>
            {
                db.SetFolderAnnotation(req.folderId, req.annotation, req.color);
                return Results.Ok(new { });
            });

            app.MapPost("/api/library/force-update-preview", (ForceUpdatePreviewRequest req, DatabaseManager db, PreviewManager pm) =>
            {
                string? hash = db.GetFileHash(req.id);
                if (hash != null)
                {
                    pm.DeletePreviewsByHash(hash);
                    // Broadcast that preview is generating to show spinner
                    _ = Broadcast(new { type = "preview.generating", fileId = req.id });
                    
                    // The next time the client asks for this image, it will be missing and regenerated live.
                    // Or we could trigger it here? Triggering here is safer to ensure it finishes.
                    // We don't have a direct reference to workers here, but the WebSocket request will trigger it.
                    // Let's broadcast that it was 'deleted' so client clears cache
                    _ = Broadcast(new { type = "preview.deleted", fileId = req.id });
                }
                return Results.Ok(new { });
            });

            app.MapPost("/api/library/cancel-task", (IdRequest req) =>
            {
                if (_activeTasks.TryRemove(req.id, out var cts))
                {
                    cts.Cancel();
                    return Results.Ok(new { message = "Task cancelled" });
                }
                return Results.NotFound();
            });

            app.MapPost("/api/settings/get", (NameRequest req, DatabaseManager db) =>
            {
                return Results.Ok(new { value = db.GetSetting(req.name) });
            });

            app.MapPost("/api/settings/set", (SettingRequest req, DatabaseManager db) =>
            {
                db.SetSetting(req.key, req.value);
                return Results.Ok(new { });
            });

            app.MapPost("/api/export/prepare", (ZipRequest req) =>
            {
                string token = Guid.NewGuid().ToString();
                _exportCache[token] = req;
                _ = Task.Run(async () => { await Task.Delay(TimeSpan.FromMinutes(5)); _exportCache.TryRemove(token, out _); });
                return Results.Ok(new { token });
            });

            app.MapGet("/api/export/download", async (string token, HttpContext context, DatabaseManager db) =>
            {
                if (!_exportCache.TryRemove(token, out var req)) return Results.NotFound();
                string zipFileName = $"{SanitizeFilename(req.name ?? "export")}_{req.type}.zip";
                context.Response.ContentType = "application/zip";
                context.Response.Headers.ContentDisposition = $"attachment; filename={zipFileName}";
                using (var archive = new ZipArchive(context.Response.BodyWriter.AsStream(), ZipArchiveMode.Create))
                {
                    var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var id in req.fileIds)
                    {
                        string? fullPath = db.GetFullFilePath(id);
                        if (string.IsNullOrEmpty(fullPath) || !File.Exists(fullPath)) continue;
                        string entryName = (req.type == "previews" || TableConstants.RawExtensions.Contains(Path.GetExtension(fullPath))) ? Path.GetFileNameWithoutExtension(fullPath) + ".jpg" : Path.GetFileName(fullPath);
                        string uniqueName = entryName;
                        int counter = 1;
                        while (usedNames.Contains(uniqueName)) { string ext = Path.GetExtension(entryName); string nameNoExt = Path.GetFileNameWithoutExtension(entryName); uniqueName = $"{nameNoExt}-{counter}{ext}"; counter++; }
                        usedNames.Add(uniqueName);
                        var entry = archive.CreateEntry(uniqueName, CompressionLevel.NoCompression);
                        using (var entryStream = entry.Open())
                        {
                            if (req.type == "previews" || TableConstants.RawExtensions.Contains(Path.GetExtension(fullPath))) 
                            { 
                                _logger?.LogDebug("[EXPORT] Processing {Path}", fullPath);
                                using var image = new MagickImage(fullPath); 
                                image.AutoOrient(); 
                                image.Format = MagickFormat.Jpg; 
                                image.Quality = 85; 
                                image.Write(entryStream); 
                                _currentProcess.Refresh();
                                if (_currentProcess.WorkingSet64 > 1024L * 1024 * 1024) GC.Collect(1, GCCollectionMode.Optimized, false);
                            }
                            else { using var fs = File.OpenRead(fullPath); await fs.CopyToAsync(entryStream); }
                        }
                        await context.Response.Body.FlushAsync();
                    }
                }
                return Results.Empty;
            });

            app.MapGet("/api/download/{fileId}", (string fileId, DatabaseManager db) =>
            {
                string? fullPath = db.GetFullFilePath(fileId);
                if (fullPath == null || !File.Exists(fullPath)) return Results.NotFound();
                return Results.File(fullPath, GetContentType(fullPath), Path.GetFileName(fullPath));
            });

            app.MapGet("/", () => ServeEmbeddedFile("PhotoLibrary.wwwroot.index.html", "text/html"));
            app.MapGet("/{*path}", (string path) => {
                if (string.IsNullOrEmpty(path)) return Results.NotFound();
                string resourceName = "PhotoLibrary.wwwroot." + path.Replace('/', '.');
                string contentType = GetContentType(path);
                return ServeEmbeddedFile(resourceName, contentType);
            });

            app.MapGet("/ws", async (HttpContext context, DatabaseManager db, PreviewManager pm) =>
            {
                // REQ-ARCH-00010
                if (context.WebSockets.IsWebSocketRequest)
                {
                    string clientId = context.Request.Query["clientId"].ToString() ?? "unknown";
                    var ws = await context.WebSockets.AcceptWebSocketAsync();
                    var lockobj = new SemaphoreSlim(1, 1);
                    var entry = (ws, lockobj, clientId);
                    _activeSockets.Add(entry);
                    try {
                        await HandleWebSocket((ws, lockobj), db, pm, lifetime.ApplicationStopping);
                    } finally {
                        // socket closed
                    }
                }
                else context.Response.StatusCode = 400;
            });

            app.Run();
        }

        private static void StartImageWorker(DatabaseManager db, PreviewManager pm)
        {
            Task.Run(async () =>
            {
                while (true)
                {
                    await _queueSemaphore.WaitAsync();
                    QueuedImageRequest? item = null;
                    lock (_queueLock)
                    {
                        _requestQueue.TryDequeue(out item, out _);
                    }

                    if (item == null) continue;
                    
                    if (item.Tcs != null && item.Tcs.Task.IsCompleted) continue; // Skip if already fulfilled by a promoted request

                    long dequeuedTime = Stopwatch.GetTimestamp();
                    item.QueueMs = Stopwatch.GetElapsedTime(item.StartTime, dequeuedTime).TotalMilliseconds;

                    if (item.ct.IsCancellationRequested || (item.Socket != null && item.Socket.State != WebSocketState.Open))
                    {
                        if (item.Socket != null) _pendingTaskSources.TryRemove((item.Socket, item.Request.requestId), out _);
                        item.Tcs?.TrySetCanceled();
                        continue;
                    }

                    try
                    {
                        var req = item.Request;
                        byte[]? data = null;
                        long retrievalStart = Stopwatch.GetTimestamp();

                        if (req.size == 0) // Full Resolution Request
                        {
                            string? fullPath = db.GetFullFilePath(req.fileId);
                            if (fullPath != null && File.Exists(fullPath))
                            {
                                string ext = Path.GetExtension(fullPath);
                                if (TableConstants.RawExtensions.Contains(ext))
                                {
                                    item.RetrievalMs = Stopwatch.GetElapsedTime(retrievalStart).TotalMilliseconds;
                                    long genStart = Stopwatch.GetTimestamp();
                                    var fileLock = _fileLocks.GetOrAdd(req.fileId, _ => new SemaphoreSlim(1, 1));
                                    await fileLock.WaitAsync();
                                    Interlocked.Increment(ref _activeMagickTasks);
                                    try
                                    {
                                        _currentProcess.Refresh();
                                        long memBefore = _currentProcess.WorkingSet64 / 1024 / 1024;
                                        using var image = new MagickImage(fullPath);
                                        image.AutoOrient();
                                        image.Format = MagickFormat.Jpg;
                                        image.Quality = 90;
                                        data = image.ToByteArray();
                                        _currentProcess.Refresh();
                                        long memAfter = _currentProcess.WorkingSet64 / 1024 / 1024;
                                        _logger?.LogDebug("[MAGICK] FullRes {Id}. Process Mem: {Before}MB -> {After}MB (+{Diff}MB). Active: {Active}", 
                                            req.fileId, memBefore, memAfter, memAfter - memBefore, _activeMagickTasks);
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
                                }
                                else {
                                    data = await File.ReadAllBytesAsync(fullPath, item.ct);
                                    item.RetrievalMs = Stopwatch.GetElapsedTime(retrievalStart).TotalMilliseconds;
                                }
                            }
                        }
                        else 
                        {
                            string? hash = db.GetFileHash(req.fileId);
                            data = hash != null ? pm.GetPreviewData(hash, req.size) : null;
                            
                            if (data == null)
                            {
                                string? fullPath = db.GetFullFilePath(req.fileId);
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
                                        
                                        using (var stream = File.Open(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read))
                                        {
                                            if (hash == null) {
                                                var hasher = new System.IO.Hashing.XxHash64();
                                                hasher.Append(stream);
                                                hash = Convert.ToHexString(hasher.GetCurrentHash()).ToLowerInvariant();
                                                stream.Position = 0;
                                                db.UpdateFileHash(req.fileId, hash);
                                            }

                                            // Re-check previews DB
                                            data = pm.GetPreviewData(hash, req.size);
                                            if (data != null) {
                                                item.RetrievalMs = Stopwatch.GetElapsedTime(retrievalStart).TotalMilliseconds;
                                                item.Payload = data;
                                                item.Tcs?.TrySetResult(data);
                                                continue;
                                            }

                                            long genStart = Stopwatch.GetTimestamp();
                                            var fileLock = _fileLocks.GetOrAdd(hash!, _ => new SemaphoreSlim(1, 1));
                                            await fileLock.WaitAsync();
                                            
                                            // RE-CHECK after acquiring lock: Maybe another thread just finished it
                                            var existingData = pm.GetPreviewData(hash!, req.size);
                                            if (existingData != null)
                                            {
                                                fileLock.Release();
                                                if (item.Tcs != null) {
                                                    item.RetrievalMs = Stopwatch.GetElapsedTime(retrievalStart).TotalMilliseconds;
                                                    item.Payload = existingData;
                                                    item.Tcs.TrySetResult(existingData);
                                                }
                                                continue;
                                            }

                                            Interlocked.Increment(ref _activeMagickTasks);
                                            try
                                            {
                                                _currentProcess.Refresh();
                                                long memBefore = _currentProcess.WorkingSet64 / 1024 / 1024;
                                                using var image = new MagickImage(stream);
                                                _ = Broadcast(new { type = "preview.generating", fileId = req.fileId });
                                                image.AutoOrient();
                                                
                                                _currentProcess.Refresh();
                                                long memAfter = _currentProcess.WorkingSet64 / 1024 / 1024;
                                                _logger?.LogDebug("[MAGICK] Loaded {Id}. Process Mem: {Before}MB -> {After}MB (+{Diff}MB). Active Tasks: {Active}", 
                                                    req.fileId, memBefore, memAfter, memAfter - memBefore, _activeMagickTasks);

                                                int[] targetSizes = { 300, 1024 };
                                                foreach (var targetSize in targetSizes)
                                                {
                                                    if (!isRaw && image.Width <= targetSize && image.Height <= targetSize)
                                                    {
                                                        var bytes = File.ReadAllBytes(sourcePath);
                                                        pm.SavePreview(hash, targetSize, bytes);
                                                        if (targetSize == req.size && item.Tcs != null) data = bytes;
                                                        continue;
                                                    }

                                                    using (var clone = image.Clone())
                                                    {
                                                        if (clone.Width > clone.Height) clone.Resize((uint)targetSize, 0);
                                                        else clone.Resize(0, (uint)targetSize);
                                                        
                                                        clone.Format = MagickFormat.WebP;
                                                        clone.Quality = 80;
                                                        var generated = clone.ToByteArray();
                                                        
                                                        pm.SavePreview(hash, targetSize, generated);
                                                        if (targetSize == req.size && item.Tcs != null) data = generated;
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
                                            
                                            string? fileRootId = db.GetFileRootId(req.fileId);
                                            _ = Broadcast(new { type = "preview.generated", fileId = req.fileId, rootId = fileRootId });
                                        }
                                    } catch (Exception ex) { _logger?.LogError(ex, "Live Gen Failed for {Id}", req.fileId); }
                                }
                            }
                            item.RetrievalMs = Stopwatch.GetElapsedTime(retrievalStart).TotalMilliseconds - item.GeneratingMs;
                        }

                        byte[] finalData = data ?? Array.Empty<byte>();
                        item.Payload = finalData;
                        item.Tcs?.TrySetResult(finalData);
                    }
                    catch (Exception ex)
                    {
                        item.Tcs?.TrySetException(ex);
                    }
                }
            });
        }

        private static async Task HandleWebSocket((WebSocket socket, SemaphoreSlim lockobj) entry, DatabaseManager db, PreviewManager pm, CancellationToken ct)
        {
            var ws = entry.socket;
            var buffer = new byte[1024 * 4];
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                try {
                    var wsResult = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                    if (wsResult.MessageType == WebSocketMessageType.Text)
                    {
                        var json = Encoding.UTF8.GetString(buffer, 0, wsResult.Count);
                        
                        // REQ-ARCH-00010: Process each request concurrently so slow generations don't block the socket
                        _ = Task.Run(async () => {
                            try {
                                var req = JsonSerializer.Deserialize<ImageRequest>(json);
                                if (req != null)
                                {
                                    long startTime = Stopwatch.GetTimestamp();
                                    
                                    // Optimization: Check DB immediately before enqueuing.
                                    string? hash = db.GetFileHash(req.fileId);
                                    byte[]? immediateData = (hash != null && req.size > 0) ? pm.GetPreviewData(hash, req.size) : null;

                                    byte[] payload;
                                    QueuedImageRequest? reqObj = null;
                                    double fastRetrievalMs = 0;

                                    if (immediateData != null)
                                    {
                                        payload = immediateData;
                                        fastRetrievalMs = Stopwatch.GetElapsedTime(startTime).TotalMilliseconds;
                                    }
                                    else
                                    {
                                        var tcs = _pendingTaskSources.GetOrAdd((ws, req.requestId), _ => new TaskCompletionSource<byte[]>());
                                        
                                        lock (_queueLock)
                                        {
                                            double p = req.priority;
                                            reqObj = new QueuedImageRequest(req, ws, entry.lockobj, tcs, ct, startTime, p);
                                            _requestQueue.Enqueue(reqObj, -p);
                                        }
                                        _queueSemaphore.Release();
                                        payload = await tcs.Task;
                                        _pendingTaskSources.TryRemove((ws, req.requestId), out _);
                                    }

                                    if (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
                                    {
                                        long beforeSend = Stopwatch.GetTimestamp();
                                        var response = new byte[4 + payload.Length];
                                        BitConverter.GetBytes(req.requestId).CopyTo(response, 0);
                                        payload.CopyTo(response, 4);
                                        
                                        // Ensure only one thread sends to this socket at a time
                                        await entry.lockobj.WaitAsync();
                                        try {
                                            if (ws.State == WebSocketState.Open)
                                                await ws.SendAsync(new ArraySegment<byte>(response), WebSocketMessageType.Binary, true, ct);
                                        } finally { entry.lockobj.Release(); }
                                        
                                        long sendingMs = (long)Stopwatch.GetElapsedTime(beforeSend).TotalMilliseconds;
                                        if (reqObj != null)
                                        {
                                            Console.WriteLine($"Fetching {req.fileId} priority {reqObj.Priority} overall {Stopwatch.GetElapsedTime(startTime).TotalMilliseconds:F2}ms queuetime {reqObj.QueueMs:F2}ms retrieval {reqObj.RetrievalMs:F2}ms generatingpreview {reqObj.GeneratingMs:F2}ms sending {sendingMs}ms");
                                        }
                                        else if (immediateData != null)
                                        {
                                            Console.WriteLine($"Fetching {req.fileId} priority {req.priority} FASTPATH retrieval {fastRetrievalMs:F2}ms sending {sendingMs}ms");
                                        }
                                    }
                                }
                            } catch (Exception ex) { if (ws.State == WebSocketState.Open) _logger?.LogError(ex, "Error processing concurrent WS request"); }
                        }, ct);
                    }
                    else if (wsResult.MessageType == WebSocketMessageType.Close)
                    {
                        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closed", ct);
                    }
                } catch (OperationCanceledException) { break; }
                catch (Exception ex) { if (ws.State == WebSocketState.Open) _logger?.LogError(ex, "WS Receive Error"); }
            }
        }

        // REQ-ARCH-00010
        private static async Task Broadcast(object message, string? targetClientId = null)
        {
            var json = JsonSerializer.Serialize(message);
            var buffer = Encoding.UTF8.GetBytes(json);
            
            var tasks = new List<Task>();
            foreach (var (socket, lockobj, clientId) in _activeSockets)
            {
                if (socket.State == WebSocketState.Open)
                {
                    if (targetClientId != null && clientId != targetClientId) continue;

                    tasks.Add(Task.Run(async () => {
                        await lockobj.WaitAsync();
                        try {
                            if (socket.State == WebSocketState.Open)
                                await socket.SendAsync(new ArraySegment<byte>(buffer), WebSocketMessageType.Text, true, CancellationToken.None);
                        } catch { }
                        finally { lockobj.Release(); }
                    }));
                }
            }
            await Task.WhenAll(tasks);
        }

        private static IResult ServeEmbeddedFile(string resourceName, string contentType)
        {
            var assembly = Assembly.GetExecutingAssembly();
            var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream == null) return Results.NotFound();
            return Results.Stream(stream, contentType);
        }

        private static string GetContentType(string path)
        {
            if (path.EndsWith(".js")) return "application/javascript";
            if (path.EndsWith(".css")) return "text/css";
            if (path.EndsWith(".html")) return "text/html";
            if (path.EndsWith(".png")) return "image/png";
            if (path.EndsWith(".jpg") || path.EndsWith(".jpeg")) return "image/jpeg";
            return "application/octet-stream";
        }

        private static string SanitizeFilename(string name)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name;
        }
    }

    public class LoggerProviderProxy : ILoggerProvider
    {
        private readonly ILoggerFactory _factory;
        public LoggerProviderProxy(ILoggerFactory factory) => _factory = factory;
        public ILogger CreateLogger(string categoryName) => _factory.CreateLogger(categoryName);
        public void Dispose() { }
    }
}