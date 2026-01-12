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
        private static readonly ConcurrentBag<WebSocket> _activeSockets = new();
        private static readonly ConcurrentDictionary<string, CancellationTokenSource> _activeTasks = new();
        private static ILogger? _logger;

        public static void Start(int port, DatabaseManager dbManager, PreviewManager previewManager, ILoggerFactory loggerFactory, string bindAddr = "localhost")
        {
            _logger = loggerFactory.CreateLogger("WebServer");

            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.Logging.AddProvider(new LoggerProviderProxy(loggerFactory));

            builder.WebHost.UseUrls($"http://{bindAddr}:{port}");
            builder.Services.Configure<HostOptions>(opts => opts.ShutdownTimeout = TimeSpan.FromSeconds(2));

            builder.Services.AddSingleton(dbManager);
            builder.Services.AddSingleton(previewManager);
            builder.Services.AddSingleton(loggerFactory);

            var app = builder.Build();
            var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
            app.UseWebSockets();

            // --- API Endpoints ---

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
                var roots = db.GetAllRootPaths();
                return Results.Ok(roots);
            });

            app.MapPost("/api/library/info", (DatabaseManager db, PreviewManager pm) =>
            {
                return Results.Ok(db.GetLibraryInfo(pm.DbPath));
            });

            app.MapPost("/api/library/stats", (DatabaseManager db) =>
            {
                return Results.Ok(db.GetGlobalStats());
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
                var ids = db.GetCollectionFiles(req.id);
                return Results.Ok(ids);
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

                try
                {
                    string absPath = PathUtils.ResolvePath(req.name);
                    if (!Directory.Exists(absPath)) {
                        _logger?.LogDebug("Directory not found: {AbsPath}", absPath);
                        return Results.Ok(new { files = Array.Empty<string>() });
                    }
                    
                    // Lazy enumeration + immediate extension filtering to save IO/Memory
                    var enumerator = Directory.EnumerateFiles(absPath, "*", SearchOption.AllDirectories)
                        .Where(f => TableConstants.SupportedExtensions.Contains(Path.GetExtension(f)));

                    var newFiles = new List<string>();
                    
                    // Batch the DB existence check to use a single connection
                    using var connection = new SqliteConnection($"Data Source={db.DbPath}");
                    connection.Open();

                    foreach (var file in enumerator)
                    {
                        var fullFile = Path.GetFullPath(file);
                        if (!db.FileExists(fullFile, connection))
                        {
                            newFiles.Add(Path.GetRelativePath(absPath, fullFile));
                        }
                        if (newFiles.Count >= 1000) break;
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
                        var sizes = new List<int>();
                        if (req.generateLow) sizes.Add(300);
                        if (req.generateMedium) sizes.Add(1024);

                        var scanner = new ImageScanner(db, logFact.CreateLogger<ImageScanner>(), pm, sizes.ToArray());
                        scanner.OnFileProcessed += (id, path) => 
                        {
                            _ = Broadcast(new { type = "file.imported", id, path });
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
                                    scanner.ProcessSingleFile(new FileInfo(fullPath), absRoot);
                                    count++;
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

                        foreach (var fId in fileIds)
                        {
                            if (cts.Token.IsCancellationRequested) break;

                            processed++;
                            // Check if previews exist, generate if not
                            var low = pm.GetPreviewData(fId, 300);
                            var med = pm.GetPreviewData(fId, 1024);

                            if (low == null || med == null)
                            {
                                string? fullPath = db.GetFullFilePath(fId);
                                if (fullPath != null && File.Exists(fullPath))
                                {
                                    var scanner = new ImageScanner(db, logFact.CreateLogger<ImageScanner>(), pm, new[] { 300, 1024 });
                                    scanner.GeneratePreviews(new FileInfo(fullPath), fId);
                                }
                            }

                            if (processed % 5 == 0 || processed == total)
                            {
                                await Broadcast(new { type = "folder.progress", rootId = req.rootId, processed, total });
                            }
                        }
                    }
                    catch (Exception ex) { _logger?.LogError(ex, "[WS] Thumbnail gen error"); }
                    finally
                    {
                        _activeTasks.TryRemove(taskId, out _);
                        await Broadcast(new { type = "folder.finished", rootId = req.rootId });
                    }
                });

                return Results.Ok(new { taskId });
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

            // 1. Prepare Export
            app.MapPost("/api/export/prepare", async (HttpContext context) =>
            {
                var req = await context.Request.ReadFromJsonAsync<ZipRequest>();
                if (req == null || req.fileIds == null) return Results.BadRequest();
                string token = Guid.NewGuid().ToString();
                _exportCache[token] = req;
                
                // Auto-cleanup token after 5 minutes
                _ = Task.Run(async () => {
                    await Task.Delay(TimeSpan.FromMinutes(5));
                    _exportCache.TryRemove(token, out _);
                });

                return Results.Ok(new { token });
            });

            // 2. Stream Download (GET)
            app.MapGet("/api/export/download", async (string token, HttpContext context, DatabaseManager db) =>
            {
                if (!_exportCache.TryRemove(token, out var req)) return Results.NotFound();

                string sanitizedName = SanitizeFilename(req.name ?? "export");
                string zipFileName = $"{sanitizedName}_{req.type}.zip";

                context.Response.ContentType = "application/zip";
                context.Response.Headers.ContentDisposition = $"attachment; filename={zipFileName}";

                // Use NoCompression for speed since images are already compressed
                using (var archive = new ZipArchive(context.Response.BodyWriter.AsStream(), ZipArchiveMode.Create))
                {
                    var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var id in req.fileIds)
                    {
                        string? fullPath = db.GetFullFilePath(id);
                        if (string.IsNullOrEmpty(fullPath) || !File.Exists(fullPath)) continue;

                        string entryName = Path.GetFileName(fullPath);
                        if (req.type == "previews") entryName = Path.GetFileNameWithoutExtension(entryName) + ".jpg";

                        string uniqueName = entryName;
                        int counter = 1;
                        while (usedNames.Contains(uniqueName))
                        {
                            string ext = Path.GetExtension(entryName);
                            string nameNoExt = Path.GetFileNameWithoutExtension(entryName);
                            uniqueName = $"{nameNoExt}-{counter}{ext}";
                            counter++;
                        }
                        usedNames.Add(uniqueName);

                        var entry = archive.CreateEntry(uniqueName, CompressionLevel.NoCompression);
                        using (var entryStream = entry.Open())
                        {
                            if (req.type == "previews")
                            {
                                using var image = new ImageMagick.MagickImage(fullPath);
                                image.AutoOrient();
                                image.Format = ImageMagick.MagickFormat.Jpg;
                                image.Quality = 85;
                                image.Write(entryStream);
                            }
                            else
                            {
                                using var fs = File.OpenRead(fullPath);
                                await fs.CopyToAsync(entryStream);
                            }
                        }
                        // Flush after every file to keep the browser happy
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
                    using var ws = await context.WebSockets.AcceptWebSocketAsync();
                    _activeSockets.Add(ws);
                    try {
                        await HandleWebSocket(ws, db, pm, lifetime.ApplicationStopping);
                    } finally {
                        _activeSockets.TryTake(out _);
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
            foreach (var ws in _activeSockets)
            {
                if (ws.State == WebSocketState.Open)
                {
                    try {
                        await ws.SendAsync(new ArraySegment<byte>(data), WebSocketMessageType.Text, true, CancellationToken.None);
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

        private static async Task HandleWebSocket(WebSocket ws, DatabaseManager db, PreviewManager pm, CancellationToken ct)
        {
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
                                _logger?.LogDebug("[WS] Full Res Path resolved to: {FullPath}", fullPath ?? "NULL");
                                if (fullPath != null && File.Exists(fullPath))
                                {
                                    string ext = Path.GetExtension(fullPath).ToUpper();
                                    if (ext == ".ARW")
                                    {
                                        using var image = new ImageMagick.MagickImage(fullPath);
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
                                data = pm.GetPreviewData(req.fileId, req.size);
                                if (data == null) // Generate on-the-fly
                                {
                                    string? fullPath = db.GetFullFilePath(req.fileId);
                                    _logger?.LogDebug("[WS] Preview {Size}px Path resolved to: {FullPath}", req.size, fullPath ?? "NULL");
                                    if (fullPath != null && File.Exists(fullPath))
                                    {
                                        try 
                                        {
                                            _logger?.LogDebug("Live generating {Size}px preview for {FullPath}", req.size, fullPath);
                                            string sourcePath = fullPath;
                                            string ext = Path.GetExtension(fullPath).ToUpper();
                                            bool isRaw = ext == ".ARW";
                                            if (isRaw)
                                            {
                                                string sidecar = Path.ChangeExtension(fullPath, ".JPG");
                                                if (!File.Exists(sidecar)) sidecar = Path.ChangeExtension(fullPath, ".jpg");
                                                if (File.Exists(sidecar)) { sourcePath = sidecar; isRaw = false; }
                                            }

                                            using var image = new ImageMagick.MagickImage(sourcePath);
                                            image.AutoOrient();

                                            // If it's not a RAW and it's already smaller than requested, just use original
                                            if (!isRaw && image.Width <= req.size && image.Height <= req.size)
                                            {
                                                data = File.ReadAllBytes(sourcePath);
                                            }
                                            else
                                            {
                                                if (image.Width > image.Height) image.Resize((uint)req.size, 0);
                                                else image.Resize(0, (uint)req.size);
                                                
                                                image.Format = ImageMagick.MagickFormat.Jpg;
                                                image.Quality = 85;
                                                data = image.ToByteArray();
                                                
                                                // Save to cache
                                                pm.SavePreview(req.fileId, req.size, data);
                                            }
                                        }
                                        catch (Exception ex)
                                        {
                                            _logger?.LogError(ex, "Live preview gen failed for {FileId}", req.fileId);
                                        }
                                    }
                                    else
                                    {
                                        _logger?.LogWarning("Cannot generate preview: Path null or File not found. ID: {FileId}, Path: {FullPath}", req.fileId, fullPath ?? "NULL");
                                    }
                                }
                            }

                            if (!ct.IsCancellationRequested)
                            {
                                // Always send a response, even if data is null (empty payload)
                                // to ensure the frontend promise resolves/fails instead of hanging.
                                var payload = data ?? Array.Empty<byte>();
                                _logger?.LogDebug("[WS] Sending response for {ReqId}. Size: {Len} bytes.", req.requestId, payload.Length);
                                var response = new byte[4 + payload.Length];
                                BitConverter.GetBytes(req.requestId).CopyTo(response, 0);
                                payload.CopyTo(response, 4);
                                await ws.SendAsync(new ArraySegment<byte>(response), WebSocketMessageType.Binary, true, ct);
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

    // Proxy class to inject our main logger factory into the builder's logging system
    public class LoggerProviderProxy : ILoggerProvider
    {
        private readonly ILoggerFactory _factory;
        public LoggerProviderProxy(ILoggerFactory factory) => _factory = factory;
        public ILogger CreateLogger(string categoryName) => _factory.CreateLogger(categoryName);
        public void Dispose() { }
    }
}