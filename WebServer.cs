using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace PhotoLibrary
{
    public static class WebServer
    {
        public static void Start(int port, string libraryPath, string previewPath)
        {
            var dbManager = new DatabaseManager(libraryPath);
            dbManager.Initialize();

            var previewManager = new PreviewManager(previewPath);
            previewManager.Initialize();

            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseUrls($"http://*:{port}");

            builder.Services.AddSingleton(dbManager);
            builder.Services.AddSingleton(previewManager);

            var app = builder.Build();
            app.UseWebSockets();

            // --- API Endpoints (All POST with JSON bodies) ---

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
                return Results.Ok();
            });

            app.MapPost("/api/rate", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<RateRequest>();
                if (req == null) return Results.BadRequest();
                db.SetRating(req.id, req.rating);
                return Results.Ok();
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
                return Results.Ok();
            });

            app.MapPost("/api/collections/add-files", async (HttpContext context, DatabaseManager db) =>
            {
                var req = await context.Request.ReadFromJsonAsync<CollectionAddRequest>();
                if (req == null) return Results.BadRequest();
                db.AddFilesToCollection(req.collectionId, req.fileIds);
                return Results.Ok();
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
                return Results.Ok();
            });

            app.MapPost("/api/picked/ids", (DatabaseManager db) =>
            {
                return Results.Ok(db.GetPickedIds());
            });

            app.MapPost("/api/stats", (DatabaseManager db) =>
            {
                return Results.Ok(db.GetGlobalStats());
            });

            // WebSocket: Image Stream
            app.Use(async (context, next) =>
            {
                if (context.Request.Path == "/ws")
                {
                    if (context.WebSockets.IsWebSocketRequest)
                    {
                        var ws = await context.WebSockets.AcceptWebSocketAsync();
                        await HandleWebSocket(ws, context.RequestServices.GetRequiredService<PreviewManager>());
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

        private static IResult ServeEmbeddedFile(string resourceName, string contentType)
        {
            var assembly = Assembly.GetExecutingAssembly();
            var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream == null) return Results.NotFound();
            return Results.Stream(stream, contentType);
        }

        private static async Task HandleWebSocket(WebSocket ws, PreviewManager pm)
        {
            var buffer = new byte[1024 * 4];
            while (ws.State == WebSocketState.Open)
            {
                var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Text)
                {
                    var json = Encoding.UTF8.GetString(buffer, 0, result.Count);
                    try
                    {
                        var req = JsonSerializer.Deserialize<ImageRequest>(json);
                        if (req != null)
                        {
                            var data = pm.GetPreviewData(req.fileId, req.size);
                            if (data != null)
                            {
                                var response = new byte[4 + data.Length];
                                BitConverter.GetBytes(req.requestId).CopyTo(response, 0);
                                data.CopyTo(response, 4);
                                await ws.SendAsync(new ArraySegment<byte>(response), WebSocketMessageType.Binary, true, CancellationToken.None);
                            }
                        }
                    }
                    catch (Exception ex) { Console.WriteLine($"WS Error: {ex.Message}"); }
                }
                else if (result.MessageType == WebSocketMessageType.Close)
                {
                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closed", CancellationToken.None);
                }
            }
        }

        // --- DTOs ---
        public record IdRequest(string id);
        public record NameRequest(string name);
        public record PickRequest(string id, bool isPicked);
        public record RateRequest(string id, int rating);
        public record SearchRequest(string tag, string value);
        public record CollectionAddRequest(string collectionId, string[] fileIds);
        public record PagedPhotosRequest(int? limit, int? offset, string? rootId, bool? pickedOnly, int? rating, string[]? specificIds);
        public class ImageRequest { public int requestId { get; set; } public string fileId { get; set; } = ""; public int size { get; set; } }
    }
}
