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

namespace PhotoLibrary.Backend;

// REQ-ARCH-00004
public static class WebServer
{
    private static readonly string _assemblyName = typeof(WebServer).Assembly.GetName().Name!;
    private static readonly ConcurrentBag<(WebSocket socket, SemaphoreSlim lockobj, string clientId)> _activeSockets = new();
    private static readonly ConcurrentDictionary<string, CancellationTokenSource> _activeTasks = new();
    private static ILogger? _logger;
    private static readonly Process _currentProcess = Process.GetCurrentProcess();
    private static CommunicationLayer? _commLayer;

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

    private static void Enqueue(ImageRequest req, CancellationToken ct)
    {
        lock (_queueLock)
        {
            var qReq = new QueuedImageRequest(req, null, null, null, ct, Stopwatch.GetTimestamp(), req.priority);
            _requestQueue.Enqueue(qReq, -req.priority);
        }
        _queueSemaphore.Release();
    }

    public static async Task StartAsync(int port, IDatabaseManager dbManager, IPreviewManager previewManager, ICameraManager cameraManager, ILoggerFactory loggerFactory, string bindAddr = "localhost", string configPath = "", string runtimeMode = "WebHost")
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

        _commLayer = new CommunicationLayer(dbManager, previewManager, cameraManager, loggerFactory, configPath, (msg) => Broadcast(msg), _activeTasks, runtimeMode);

        // REQ-WFE-00024
        RuntimeStatistics.Instance.RegisterBroadcastHandler(msg => _ = Broadcast(msg));
        RuntimeStatistics.Instance.Start();

        var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
        app.UseWebSockets();

        dbManager.RegisterFolderCreatedHandler((id, name) => {
            _ = Broadcast(new { type = "folder.created", directoryId = id, name });
        });

        // --- API Endpoints ---
        // REQ-ARCH-00007

        app.MapPost("/api/get-application-settings", () => Results.Ok(_commLayer?.GetApplicationSettings()));

        app.MapGet("/api/camera/thumbnail/{model}", (string model) => {
            var res = _commLayer?.GetCameraThumbnail(model);
            return res == null ? Results.NotFound() : Results.Bytes(res.Data, "image/webp");
        });

        app.MapPost("/api/photos", (PagedPhotosRequest req) => Results.Ok(_commLayer?.GetPhotosPaged(req)));

        app.MapPost("/api/metadata", (FileIdRequest req) => Results.Ok(_commLayer?.GetMetadata(req)));

        app.MapPost("/api/directories", () => Results.Ok(_commLayer?.GetDirectories()));

        app.MapPost("/api/library/info", () => Results.Ok(_commLayer?.GetLibraryInfo()));

        app.MapPost("/api/library/backup", () => {
            var res = _commLayer?.BackupLibrary();
            return res != null && res.Success ? Results.Json(new { success = true, path = res.Data }) : Results.Json(new { success = false, error = res?.Error });
        });

        app.MapPost("/api/pick", async (PickRequest req) => {
            await _commLayer?.SetPicked(req)!;
            return Results.Ok(new { });
        });

        app.MapPost("/api/rate", async (RateRequest req) => {
            await _commLayer?.SetRating(req)!;
            return Results.Ok(new { });
        });

        app.MapPost("/api/search", (SearchRequest req) => Results.Ok(_commLayer?.Search(req)));

        app.MapPost("/api/collections/list", () => Results.Ok(_commLayer?.GetCollections()));

        app.MapPost("/api/collections/create", (NameRequest req) => Results.Ok(_commLayer?.CreateCollection(req)));

        app.MapPost("/api/collections/delete", (CollectionIdRequest req) => {
            _commLayer?.DeleteCollection(req);
            return Results.Ok(new { });
        });

        app.MapPost("/api/collections/add-files", (CollectionAddRequest req) => {
            _commLayer?.AddFilesToCollection(req);
            return Results.Ok(new { });
        });

        app.MapPost("/api/collections/get-files", (CollectionIdRequest req) => Results.Ok(_commLayer?.GetCollectionFiles(req)));

        app.MapPost("/api/picked/clear", () => {
            _commLayer?.ClearPicked();
            return Results.Ok(new { });
        });

        app.MapPost("/api/picked/ids", () => Results.Ok(_commLayer?.GetPickedIds()));

        app.MapPost("/api/stats", () => Results.Ok(_commLayer?.GetStats()));

        app.MapPost("/api/fs/list", (NameRequest req) => Results.Ok(_commLayer?.ListFileSystem(req)));

        app.MapPost("/api/fs/find-files", (NameRequest req) => Results.Ok(_commLayer?.FindFiles(req)));

        app.MapPost("/api/library/find-new-files", (NameRequest req) => Results.Ok(_commLayer?.FindNewFiles(req)));

        app.MapPost("/api/library/validate-import", (ValidateImportRequest req) => Results.Ok(_commLayer?.ValidateImport(req)));

        app.MapPost("/api/library/import-batch", (ImportBatchRequest req) => {
            _commLayer?.ImportBatch(req);
            return Results.Ok();
        });

        app.MapPost("/api/library/import-local", (ImportLocalRequest req) => {
            string taskId = _commLayer?.ImportLocal(req) ?? "";
            return Results.Json(new { success = true, taskId = taskId });
        });

        app.MapPost("/api/library/generate-thumbnails", (GenerateThumbnailsRequest req) => {
            _commLayer?.GenerateThumbnails(req, Enqueue);
            return Results.Ok();
        });

        app.MapPost("/api/library/set-annotation", (FolderAnnotationRequest req) => {
            _commLayer?.SetAnnotation(req);
            return Results.Ok();
        });

        app.MapPost("/api/library/force-update-preview", (ForceUpdatePreviewRequest req) => {
            _commLayer?.ForceUpdatePreview(req, Enqueue);
            return Results.Ok();
        });

        app.MapPost("/api/library/cancel-task", (TaskRequest req) => {
            bool success = _commLayer?.CancelTask(req) ?? false;
            return success ? Results.Ok(new { success = true }) : Results.NotFound();
        });

        app.MapPost("/api/settings/get", (NameRequest req) => Results.Ok(new { value = _commLayer?.GetSetting(req.name) }));

        app.MapPost("/api/settings/set", (SettingRequest req) => {
            _commLayer?.SetSetting(req);
            return Results.Ok();
        });

        app.MapPost("/api/export/prepare", (ZipRequest req) => Results.Ok(new { token = _commLayer?.PrepareExport(req) }));

        app.MapGet("/api/export/download", async (string token, HttpContext context) => {
            string? fileName = _commLayer?.GetExportZipName(token);
            if (fileName == null) return Results.NotFound();

            context.Response.ContentType = "application/zip";
            context.Response.Headers.ContentDisposition = $"attachment; filename={fileName}";
            
            var syncIoFeature = context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpBodyControlFeature>();
            if (syncIoFeature != null) syncIoFeature.AllowSynchronousIO = true;

            await _commLayer?.DownloadExport(token, context.Response.Body)!;
            return Results.Empty;
        });

        app.MapGet("/api/download/{fileEntryId}", (string fileEntryId) => {
            var res = _commLayer?.DownloadFile(fileEntryId);
            return res == null ? Results.NotFound() : Results.File(res.FullPath, GetContentType(res.FullPath), res.FileName);
        });

        app.MapGet("/", () => ServeEmbeddedFile($"{_assemblyName}.wwwroot.index.html", "text/html"));
        app.MapGet("/{*path}", (string path) => {
            if (string.IsNullOrEmpty(path)) return Results.NotFound();
            string resourceName = $"{_assemblyName}.wwwroot." + path.Replace('/', '.');
            return ServeEmbeddedFile(resourceName, GetContentType(path));
        });

        app.MapGet("/ws", async (HttpContext context, IDatabaseManager db, IPreviewManager pm) =>
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

        await app.RunAsync();
    }

    private static void StartImageWorker(IDatabaseManager db, IPreviewManager pm)
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
                
                if (item.Tcs != null && item.Tcs.Task.IsCompleted) continue;

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

                    if (req.size == 0)
                    {
                        string? fullPath = db.GetFullFilePath(req.fileEntryId);
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
                                    
                                    using var image = new MagickImage(tracker, settings);
                                    image.AutoOrient();
                                    image.Format = MagickFormat.WebP;
                                    image.Quality = 90;
                                    data = image.ToByteArray();
                                }
                                finally { 
                                    Interlocked.Decrement(ref _activeMagickTasks); 
                                    fileLock.Release(); 
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
                        string? hash = db.GetFileHash(req.fileEntryId);
                        data = hash != null ? pm.GetPreviewData(hash, req.size) : null;
                        
                        if (data == null)
                        {
                            string? fullPath = db.GetFullFilePath(req.fileEntryId);
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
                                            db.UpdateFileHash(req.fileEntryId, hash);
                                        }

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
                                            
                                            var settings = new MagickReadSettings {
                                                Format = GetMagickFormat(sourcePath)
                                            };
                                            
                                            using var image = new MagickImage(stream, settings);
                                            _ = Broadcast(new { type = "preview.generating", fileEntryId = req.fileEntryId });
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
                                        
                                        string? fileRootId = db.GetFileRootId(req.fileEntryId);
                                        _ = Broadcast(new { type = "preview.generated", fileEntryId = req.fileEntryId, rootId = fileRootId });
                                    }
                                } catch (Exception ex) { _logger?.LogError(ex, "Live Gen Failed for {Id}", req.fileEntryId); }
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

    private static async Task HandleWebSocket((WebSocket socket, SemaphoreSlim lockobj) entry, IDatabaseManager db, IPreviewManager pm, CancellationToken ct)
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
                    _ = Task.Run(async () => {
                        try {
                            var req = JsonSerializer.Deserialize<ImageRequest>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                            if (req != null)
                            {
                                long startTime = Stopwatch.GetTimestamp();
                                string? hash = db.GetFileHash(req.fileEntryId);
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
                                    
                                    await entry.lockobj.WaitAsync();
                                    try {
                                        if (ws.State == WebSocketState.Open)
                                            await ws.SendAsync(new ArraySegment<byte>(response), WebSocketMessageType.Binary, true, ct);
                                    } finally { entry.lockobj.Release(); }
                                    
                                    long sendingMs = (long)Stopwatch.GetElapsedTime(beforeSend).TotalMilliseconds;

                                    // PERMANENT LOGGING
                                    string sId = req.fileEntryId;
                                    string shortId = sId.Length > 12 ? $"{sId.Substring(0, 4)}...{sId.Substring(sId.Length - 4)}" : sId;
                                    if (reqObj != null)
                                    {
                                        double overall = Stopwatch.GetElapsedTime(startTime).TotalMilliseconds;
                                        Console.WriteLine($"[FETCH] {shortId,-11} | Priority: {reqObj.Priority,12:F4} | Tot: {overall,9:F1}ms | Q: {reqObj.QueueMs,8:F1}ms | Ret: {reqObj.RetrievalMs,8:F1}ms | Gen: {reqObj.GeneratingMs,8:F1}ms | Sen: {sendingMs,4}ms");
                                    }
                                    else if (immediateData != null)
                                    {
                                        double overall = Stopwatch.GetElapsedTime(startTime).TotalMilliseconds;
                                        Console.WriteLine($"[FETCH] {shortId,-11} | Priority: {req.priority,12:F4} | Tot: {overall,9:F1}ms | FASTPATH           | Ret: {fastRetrievalMs,8:F1}ms | {"",21} | Sen: {sendingMs,4}ms");
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
}

public class LoggerProviderProxy : ILoggerProvider
{
    private readonly ILoggerFactory _factory;
    public LoggerProviderProxy(ILoggerFactory factory) => _factory = factory;
    public ILogger CreateLogger(string categoryName) => _factory.CreateLogger(categoryName);
    public void Dispose() { }
}
