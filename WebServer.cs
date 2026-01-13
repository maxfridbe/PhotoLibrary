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

namespace PhotoLibrary
{
    public static class WebServer
    {
        private static readonly ConcurrentDictionary<string, ZipRequest> _exportCache = new();
        private static readonly ConcurrentBag<(WebSocket socket, SemaphoreSlim lockobj)> _activeSockets = new();
        private static readonly ConcurrentDictionary<string, CancellationTokenSource> _activeTasks = new();
        private static ILogger? _logger;

        public static void Start(int port, DatabaseManager dbManager, PreviewManager previewManager, CameraManager cameraManager, ILoggerFactory loggerFactory, string bindAddr = "localhost", string configPath = "")
        {
            _logger = loggerFactory.CreateLogger("WebServer");

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

            // --- API Endpoints ---

            app.MapGet("/api/camera/thumbnail/{model}", (string model, CameraManager cm) =>
            {
                var data = cm.GetCameraThumbnail(model);
                if (data == null) return Results.NotFound();
                return Results.Bytes(data, "image/webp"); // Or detect format, but db schema example showed webp
            });

            app.MapPost("/api/photos", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<PagedPhotosRequest>();
                if (req == null) return Results.BadRequest();
                var response = db.GetPhotosPaged(req.limit ?? 100, req.offset ?? 0, req.rootId, req.pickedOnly ?? false, req.rating ?? 0, req.specificIds);
                return Results.Ok(response);
            });

            app.MapPost("/api/metadata", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<IdRequest>();
                if (req == null) return Results.BadRequest();
                var metadata = db.GetMetadata(req.id);
                return Results.Ok(metadata);
            });

            app.MapPost("/api/directories", (DatabaseManager db) =>
            {
                return Results.Ok(db.GetAllRootPaths());
            });

            app.MapPost("/api/library/info", (DatabaseManager db, PreviewManager pm) =>
            {
                var info = db.GetLibraryInfo(pm.DbPath, configPath);
                info.IsIndexing = ImageIndexer.IsIndexing;
                info.IndexedCount = ImageIndexer.IndexedCount;
                info.TotalToIndex = ImageIndexer.TotalToIndex;
                return Results.Ok(info);
            });

            app.MapPost("/api/pick", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<PickRequest>();
                if (req == null) return Results.BadRequest();
                db.SetPicked(req.id, req.isPicked);
                return Results.Ok(new { });
            });

            app.MapPost("/api/rate", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<RateRequest>();
                if (req == null) return Results.BadRequest();
                db.SetRating(req.id, req.rating);
                return Results.Ok(new { });
            });

            app.MapPost("/api/search", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<SearchRequest>();
                if (req == null) return Results.BadRequest();
                var fileIds = db.SearchMetadata(req.tag, req.value);
                return Results.Ok(fileIds);
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

            app.MapPost("/api/library/find-new-files", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<NameRequest>();
                if (req == null || string.IsNullOrEmpty(req.name)) return Results.BadRequest();

                // Check if name contains a limit suffix like "|1000" or similar, 
                // or better, we should have updated the Request model. 
                // Since I can't easily change the model and regenerate without potential issues, 
                // I'll try to parse it from the string if present or just use a default.
                // Wait, I can update the model! Let's update NameRequest or add a new one.
                
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

            app.MapPost("/api/library/import-batch", async (HttpContext context, DatabaseManager db, PreviewManager pm, ILoggerFactory logFact) =>
            {
                var req = await context.Request.ReadFromJsonAsync<ImportBatchRequest>();
                if (req == null || req.relativePaths == null) return Results.BadRequest();

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
                    }
                });

                return Results.Ok();
            });

            app.MapPost("/api/library/generate-thumbnails", async (HttpContext context, DatabaseManager db, PreviewManager pm, ILoggerFactory logFact) =>
            {
                var req = await context.Request.ReadFromJsonAsync<GenerateThumbnailsRequest>();
                if (req == null) return Results.BadRequest();

                string taskId = $"thumbnails-{req.rootId}";
                var cts = new CancellationTokenSource();
                if (!_activeTasks.TryAdd(taskId, cts)) 
                {
                    _activeTasks[taskId].Cancel();
                    _activeTasks[taskId] = cts;
                }

                _ = Task.Run(async () =>
                {
                    try
                    {
                        var fileIds = db.GetFileIdsUnderRoot(req.rootId, req.recursive);
                        int total = fileIds.Count;
                        int processed = 0;
                        _logger?.LogInformation("Starting thumbnail generation for {Total} files in root {RootId}", total, req.rootId);

                        var indexer = new ImageIndexer(db, logFact.CreateLogger<ImageIndexer>(), pm, new[] { 300, 1024 });

                        foreach (var fId in fileIds)
                        {
                            if (cts.Token.IsCancellationRequested) break;

                            processed++;
                            string? hash = db.GetFileHash(fId);
                            if (hash == null) continue;

                            var low = pm.GetPreviewData(hash, 300);
                            var med = pm.GetPreviewData(hash, 1024);

                            if (low == null || med == null)
                            {
                                string? fullPath = db.GetFullFilePath(fId);
                                if (fullPath != null && File.Exists(fullPath))
                                {
                                    indexer.GeneratePreviews(new FileInfo(fullPath), fId);
                                }
                            }
                        }
                        _logger?.LogInformation("Finished thumbnail generation for root {RootId}. Processed {Count}/{Total}.", req.rootId, processed, total);
                        await Broadcast(new { type = "scan.finished" });
                    }
                    catch (Exception ex) { _logger?.LogError(ex, "[WS] Thumbnail gen error"); }
                    finally { _activeTasks.TryRemove(taskId, out _); }
                });

                return Results.Ok();
            });

            app.MapPost("/api/library/set-annotation", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<FolderAnnotationRequest>();
                if (req == null) return Results.BadRequest();
                db.SetFolderAnnotation(req.folderId, req.annotation, req.color);
                return Results.Ok(new { });
            });

            app.MapPost("/api/library/cancel-task", async (HttpContext context) =>
            {
                var req = await context.Request.ReadFromJsonAsync<IdRequest>();
                if (req == null) return Results.BadRequest();
                if (_activeTasks.TryRemove(req.id, out var cts))
                {
                    cts.Cancel();
                    return Results.Ok();
                }
                return Results.NotFound();
            });

            app.MapPost("/api/settings/get", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<SettingRequest>();
                if (req == null) return Results.BadRequest();
                var val = db.GetSetting(req.key);
                return Results.Ok(new { value = val });
            });

            app.MapPost("/api/settings/set", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<SettingRequest>();
                if (req == null) return Results.BadRequest();
                db.SetSetting(req.key, req.value);
                return Results.Ok(new { });
            });

            app.MapGet("/api/download/{fileId}", (string fileId, DatabaseManager db) =>
            {
                string? fullPath = db.GetFullFilePath(fileId);
                if (fullPath == null || !File.Exists(fullPath)) return Results.NotFound();
                return Results.File(fullPath, "application/octet-stream", Path.GetFileName(fullPath));
            });

            app.MapPost("/api/export/prepare", async (HttpContext context) =>
            {
                var req = await context.Request.ReadFromJsonAsync<ZipRequest>();
                if (req == null || req.fileIds == null) return Results.BadRequest();
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
                        string entryName = req.type == "previews" ? Path.GetFileNameWithoutExtension(fullPath) + ".jpg" : Path.GetFileName(fullPath);
                        string uniqueName = entryName;
                        int counter = 1;
                        while (usedNames.Contains(uniqueName)) { string ext = Path.GetExtension(entryName); string nameNoExt = Path.GetFileNameWithoutExtension(entryName); uniqueName = $"{nameNoExt}-{counter}{ext}"; counter++; }
                        usedNames.Add(uniqueName);
                        var entry = archive.CreateEntry(uniqueName, CompressionLevel.NoCompression);
                        using (var entryStream = entry.Open())
                        {
                            if (req.type == "previews") { using var image = new ImageMagick.MagickImage(fullPath); image.AutoOrient(); image.Format = ImageMagick.MagickFormat.Jpg; image.Quality = 85; image.Write(entryStream); }
                            else { using var fs = File.OpenRead(fullPath); await fs.CopyToAsync(entryStream); }
                        }
                        await context.Response.Body.FlushAsync();
                    }
                }
                return Results.Empty;
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
                if (context.WebSockets.IsWebSocketRequest)
                {
                    var ws = await context.WebSockets.AcceptWebSocketAsync();
                    var lockobj = new SemaphoreSlim(1, 1);
                    var entry = (ws, lockobj);
                    _activeSockets.Add(entry);
                    try {
                        await HandleWebSocket(entry, db, pm, lifetime.ApplicationStopping);
                    } finally {
                        // socket closed
                    }
                }
                else context.Response.StatusCode = 400;
            });

            _logger?.LogInformation("Web server running on port {Port}", port);
            app.Run();
        }

        private static async Task Broadcast(object message)
        {
            var json = JsonSerializer.Serialize(message);
            var data = Encoding.UTF8.GetBytes(json);
            foreach (var entry in _activeSockets)
            {
                if (entry.socket.State == WebSocketState.Open)
                {
                    try {
                        await entry.lockobj.WaitAsync();
                        try {
                            await entry.socket.SendAsync(new ArraySegment<byte>(data), WebSocketMessageType.Text, true, CancellationToken.None);
                        } finally { entry.lockobj.Release(); }
                    } catch { }
                }
            }
        }

        private static string SanitizeFilename(string filename)
        {
            var invalidChars = Path.GetInvalidFileNameChars();
            return string.Join("_", filename.Split(invalidChars, StringSplitOptions.RemoveEmptyEntries)).Trim().Replace(" ", "_");
        }

        private static IResult ServeEmbeddedFile(string resourceName, string contentType)
        {
            var assembly = Assembly.GetExecutingAssembly();
            var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream == null) 
            {
                _logger?.LogDebug("Resource not found: {ResourceName}", resourceName);
                return Results.NotFound();
            }
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

        private static async Task HandleWebSocket((WebSocket socket, SemaphoreSlim lockobj) entry, DatabaseManager db, PreviewManager pm, CancellationToken ct)
        {
            var ws = entry.socket;
            var buffer = new byte[1024 * 4];
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                try {
                    var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var json = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        var req = JsonSerializer.Deserialize<ImageRequest>(json);
                        if (req != null)
                        {
                            _logger?.LogDebug("[WS] Received request {ReqId} for file {FileId} size {Size}", req.requestId, req.fileId, req.size);
                            byte[]? data = null;
                            if (req.size == 0) // Full Resolution Request
                            {
                                string? fullPath = db.GetFullFilePath(req.fileId);
                                if (fullPath != null && File.Exists(fullPath))
                                {
                                    string ext = Path.GetExtension(fullPath);
                                    if (TableConstants.RawExtensions.Contains(ext))
                                    {
                                        using var image = new ImageMagick.MagickImage(fullPath);
                                        _logger?.LogDebug("[WS] Converted RAW {FileId} ({Ext}). Dimensions: {W}x{H}", req.fileId, ext, image.Width, image.Height);
                                        image.AutoOrient();
                                        image.Format = ImageMagick.MagickFormat.Jpg;
                                        image.Quality = 90;
                                        data = image.ToByteArray();
                                    }
                                    else data = await File.ReadAllBytesAsync(fullPath, ct);
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
                                            
                                            using var stream = File.Open(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read);
                                            if (hash == null) {
                                                var hasher = new System.IO.Hashing.XxHash64();
                                                hasher.Append(stream);
                                                hash = Convert.ToHexString(hasher.GetCurrentHash()).ToLowerInvariant();
                                                stream.Position = 0;
                                                db.UpdateFileHash(req.fileId, hash);
                                            }

                                            using var image = new ImageMagick.MagickImage(stream);
                                            _logger?.LogDebug("[WS] Live Gen {FileId} ({Ext}). Hash: {Hash}. Dimensions: {W}x{H}", req.fileId, ext, hash, image.Width, image.Height);
                                            
                                            // Notify clients that generation is starting (slow op)
                                            _ = Broadcast(new { type = "preview.generating", fileId = req.fileId });

                                            image.AutoOrient();
                                            if (!isRaw && image.Width <= req.size && image.Height <= req.size) { data = File.ReadAllBytes(sourcePath); }
                                            else {
                                                if (image.Width > image.Height) image.Resize((uint)req.size, 0); else image.Resize(0, (uint)req.size);
                                                image.Format = ImageMagick.MagickFormat.Jpg; image.Quality = 85;
                                                data = image.ToByteArray();
                                                pm.SavePreview(hash, req.size, data);
                                                string? rootId = db.GetFileRootId(req.fileId);
                                                if (rootId != null) _ = Broadcast(new { type = "preview.generated", fileId = req.fileId, rootId });
                                            }
                                        } catch (Exception ex) { 
                                            _logger?.LogError(ex, "Live preview gen failed for {FileId} ({FilePath}). Error: {Message}", req.fileId, fullPath, ex.Message); 
                                        }
                                    }
                                }
                            }

                            if (!ct.IsCancellationRequested)
                            {
                                var payload = data ?? Array.Empty<byte>();
                                var response = new byte[4 + payload.Length];
                                BitConverter.GetBytes(req.requestId).CopyTo(response, 0);
                                payload.CopyTo(response, 4);
                                await entry.lockobj.WaitAsync();
                                try {
                                    await ws.SendAsync(new ArraySegment<byte>(response), WebSocketMessageType.Binary, true, ct);
                                } finally { entry.lockobj.Release(); }
                            }
                        }
                    }
                    else if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closed", ct);
                    }
                } catch (OperationCanceledException) { break; }
                catch (Exception ex) { if (ws.State == WebSocketState.Open) _logger?.LogError(ex, "WS Error"); }
            }
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
