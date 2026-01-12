using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
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

        public static void Start(int port, string libraryPath, string previewPath, string bindAddr = "localhost")
        {
            var dbManager = new DatabaseManager(libraryPath);
            dbManager.Initialize();

            var previewManager = new PreviewManager(previewPath);
            previewManager.Initialize();

            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseUrls($"http://{bindAddr}:{port}");
            builder.Services.Configure<HostOptions>(opts => opts.ShutdownTimeout = TimeSpan.FromSeconds(2));

            builder.Services.AddSingleton(dbManager);
            builder.Services.AddSingleton(previewManager);

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

            app.MapPost("/api/library/info", (DatabaseManager db, PreviewManager pm) =>
            {
                var info = db.GetLibraryInfo(pm.DbPath);
                return Results.Ok(info);
            });

            app.MapPost("/api/library/find-files", async (HttpContext context) =>
            {
                var req = await context.Request.ReadFromJsonAsync<NameRequest>();
                if (req == null || string.IsNullOrEmpty(req.name)) return Results.BadRequest();
                
                try 
                {
                    if (!Directory.Exists(req.name)) return Results.Ok(new { files = Array.Empty<string>() });
                    var files = Directory.EnumerateFiles(req.name, "*", SearchOption.AllDirectories)
                        .Select(f => Path.GetRelativePath(req.name, f))
                        .ToList();
                    return Results.Ok(new { files });
                }
                catch (Exception ex)
                {
                    return Results.BadRequest(new { error = ex.Message });
                }
            });

            app.MapPost("/api/library/find-new-files", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<NameRequest>();
                if (req == null || string.IsNullOrEmpty(req.name)) return Results.BadRequest();

                try
                {
                    string absPath = Path.GetFullPath(req.name);
                    if (!Directory.Exists(absPath)) return Results.Ok(new { files = Array.Empty<string>() });
                    
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

            app.MapPost("/api/library/import-batch", async (HttpContext context, DatabaseManager db, PreviewManager pm) =>
            {
                var req = await context.Request.ReadFromJsonAsync<ImportBatchRequest>();
                if (req == null || req.relativePaths == null) return Results.BadRequest();

                _ = Task.Run(async () =>
                {
                    try
                    {
                        Console.WriteLine($"[BATCH] TASK START: Processing {req.relativePaths.Length} files.");
                        var sizes = new List<int>();
                        if (req.generateLow) sizes.Add(300);
                        if (req.generateMedium) sizes.Add(1024);

                        var scanner = new ImageScanner(db, pm, sizes.ToArray());
                        scanner.OnFileProcessed += (id, path) => 
                        {
                            _ = Broadcast(new { type = "file.imported", id, path });
                        };
                        
                        string absRoot = Path.GetFullPath(req.rootPath);
                        Console.WriteLine($"[BATCH] Resolved Root: {absRoot}");
                        
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
                                    if (count % 10 == 0) Console.WriteLine($"[BATCH] Progress: {count}/{req.relativePaths.Length}...");
                                }
                                else
                                {
                                    Console.WriteLine($"[BATCH] File not found: {fullPath}");
                                }
                            }
                            catch (Exception ex)
                            {
                                Console.WriteLine($"[BATCH] Error processing {relPath}: {ex.Message}");
                            }
                        }
                        
                        Console.WriteLine($"[BATCH] TASK FINISHED. Imported {count} files total.");
                        await Broadcast(new { type = "scan.finished" });
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"[BATCH] CRITICAL FAILURE: {ex.Message}");
                        Console.WriteLine(ex.StackTrace);
                    }
                });

                return Results.Ok(new { message = "Batch import started" });
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

            // WebSocket: Image Stream
            app.Use(async (context, next) =>
            {
                if (context.Request.Path == "/ws")
                {
                    if (context.WebSockets.IsWebSocketRequest)
                    {
                        var ws = await context.WebSockets.AcceptWebSocketAsync();
                        _activeSockets.Add(ws);
                        try 
                        {
                            await HandleWebSocket(ws, context.RequestServices.GetRequiredService<DatabaseManager>(), context.RequestServices.GetRequiredService<PreviewManager>(), lifetime.ApplicationStopping);
                        }
                        finally
                        {
                            // Remove from bag is tricky since ConcurrentBag doesn't have it easily
                            // but we filter by state during broadcast anyway.
                        }
                    }
                    else context.Response.StatusCode = 400;
                }
                else await next();
            });

            // Static Files (Embedded)
            app.MapGet("/", () => ServeEmbeddedFile("PhotoLibrary.wwwroot.index.html", "text/html"));
            app.MapGet("/{*path}", (string path) => {
                if (string.IsNullOrEmpty(path)) return Results.NotFound();
                string resourceName = "PhotoLibrary.wwwroot." + path.Replace('/', '.');
                string contentType = "application/octet-stream";
                if (path.EndsWith(".html")) contentType = "text/html";
                else if (path.EndsWith(".js")) contentType = "application/javascript";
                else if (path.EndsWith(".css")) contentType = "text/css";
                return ServeEmbeddedFile(resourceName, contentType);
            });

            Console.WriteLine($"Web server running on port {port}");
            app.Run();
        }

        private static async Task Broadcast(object message)
        {
            var json = JsonSerializer.Serialize(message);
            var bytes = Encoding.UTF8.GetBytes(json);
            var segment = new ArraySegment<byte>(bytes);

            foreach (var socket in _activeSockets)
            {
                if (socket.State == WebSocketState.Open)
                {
                    try
                    {
                        await socket.SendAsync(segment, WebSocketMessageType.Text, true, CancellationToken.None);
                    }
                    catch { /* Ignore failed sockets */ }
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
            if (stream == null) return Results.NotFound();
            return Results.Stream(stream, contentType);
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
                            Console.WriteLine($"[WS] Received request {req.requestId} for file {req.fileId} size {req.size}");
                            byte[]? data = null;
                            if (req.size == 0) // Full Resolution Request
                            {
                                string? fullPath = db.GetFullFilePath(req.fileId);
                                Console.WriteLine($"[WS] Full Res Path resolved to: {fullPath ?? "NULL"}");
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
                                    Console.WriteLine($"[WS] Preview {req.size}px Path resolved to: {fullPath ?? "NULL"}");
                                    if (fullPath != null && File.Exists(fullPath))
                                    {
                                        try 
                                        {
                                            Console.WriteLine($"Live generating {req.size}px preview for {fullPath}");
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
                                            Console.WriteLine($"Live preview gen failed for {req.fileId}: {ex.Message}");
                                        }
                                    }
                                    else
                                    {
                                        Console.WriteLine($"Cannot generate preview: Path null or File not found. ID: {req.fileId}, Path: {fullPath ?? "NULL"}");
                                    }
                                }
                            }

                            if (!ct.IsCancellationRequested)
                            {
                                // Always send a response, even if data is null (empty payload)
                                // to ensure the frontend promise resolves/fails instead of hanging.
                                var payload = data ?? Array.Empty<byte>();
                                Console.WriteLine($"[WS] Sending response for {req.requestId}. Size: {payload.Length} bytes.");
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
                catch (Exception ex) { if (ws.State == WebSocketState.Open) Console.WriteLine($"WS Error: {ex.Message}"); }
            }
        }
    }
}
