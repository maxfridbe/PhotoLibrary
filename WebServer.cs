using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
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

        public static void Start(int port, string libraryPath, string previewPath)
        {
            var dbManager = new DatabaseManager(libraryPath);
            dbManager.Initialize();

            var previewManager = new PreviewManager(previewPath);
            previewManager.Initialize();

            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseUrls($"http://*:{port}");
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
                        await HandleWebSocket(ws, context.RequestServices.GetRequiredService<DatabaseManager>(), context.RequestServices.GetRequiredService<PreviewManager>(), lifetime.ApplicationStopping);
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
                            byte[]? data = null;
                            if (req.size == 0) // Full Resolution Request
                            {
                                string? fullPath = db.GetFullFilePath(req.fileId);
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
                            else data = pm.GetPreviewData(req.fileId, req.size);

                            if (data != null && !ct.IsCancellationRequested)
                            {
                                var response = new byte[4 + data.Length];
                                BitConverter.GetBytes(req.requestId).CopyTo(response, 0);
                                data.CopyTo(response, 4);
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
