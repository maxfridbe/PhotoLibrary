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

            // API: Get Photos
            app.MapGet("/api/photos", (int? limit, int? offset, string? rootId, bool? pickedOnly, int? rating, string[]? specificIds, DatabaseManager db) =>
            {
                var photos = db.GetPhotosPaged(limit ?? 100, offset ?? 0, rootId, pickedOnly ?? false, rating ?? 0, specificIds);
                int total = db.GetTotalPhotoCount(rootId, pickedOnly ?? false, rating ?? 0, specificIds);
                return Results.Ok(new { photos, total });
            });

            // API: Get Metadata
            app.MapGet("/api/metadata/{id}", (string id, DatabaseManager db) =>
            {
                var metadata = db.GetMetadata(id);
                return Results.Ok(metadata);
            });

            // API: Get Directories
            app.MapGet("/api/directories", (DatabaseManager db) =>
            {
                var roots = db.GetAllRootPaths();
                return Results.Ok(roots);
            });

            // API: Set Picked
            app.MapPost("/api/pick/{id}", (string id, bool isPicked, DatabaseManager db) =>
            {
                db.SetPicked(id, isPicked);
                return Results.Ok();
            });

            // API: Set Rating
            app.MapPost("/api/rate/{id}/{rating}", (string id, int rating, DatabaseManager db) =>
            {
                db.SetRating(id, rating);
                return Results.Ok();
            });

            // API: Search
            app.MapGet("/api/search", (string tag, string value, DatabaseManager db) =>
            {
                var fileIds = db.SearchMetadata(tag, value);
                return Results.Ok(fileIds);
            });

            // API: Collections
            app.MapGet("/api/collections", (DatabaseManager db) =>
            {
                var list = db.GetCollections().Select(c => new { id = c.Id, name = c.Name, count = c.Count });
                return Results.Ok(list);
            });

            app.MapPost("/api/collections", (string name, DatabaseManager db) =>
            {
                var id = db.CreateCollection(name);
                return Results.Ok(new { id, name });
            });

            app.MapDelete("/api/collections/{id}", (string id, DatabaseManager db) =>
            {
                db.DeleteCollection(id);
                return Results.Ok();
            });

            app.MapPost("/api/collections/{id}/add", (string id, string[] fileIds, DatabaseManager db) =>
            {
                db.AddFilesToCollection(id, fileIds);
                return Results.Ok();
            });

            app.MapGet("/api/collections/{id}/files", (string id, DatabaseManager db) =>
            {
                var fileIds = db.GetCollectionFiles(id);
                return Results.Ok(fileIds);
            });

            app.MapPost("/api/picked/clear", (DatabaseManager db) =>
            {
                db.ClearPicked();
                return Results.Ok();
            });

            app.MapGet("/api/picked/ids", (DatabaseManager db) =>
            {
                return Results.Ok(db.GetPickedIds());
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
                    else
                    {
                        context.Response.StatusCode = 400;
                    }
                }
                else
                {
                    await next();
                }
            });

            // Static Files (Embedded)
            app.MapGet("/", () => ServeEmbeddedFile("PhotoLibrary.wwwroot.index.html", "text/html"));
            
            app.MapGet("/{*path}", (string path) => {
                if (string.IsNullOrEmpty(path)) return Results.NotFound(); // Should be caught by "/" but just in case
                
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
                                // Protocol: [4 bytes requestId (int32 little endian)] [Image Data]
                                var response = new byte[4 + data.Length];
                                BitConverter.GetBytes(req.requestId).CopyTo(response, 0);
                                data.CopyTo(response, 4);

                                await ws.SendAsync(new ArraySegment<byte>(response), WebSocketMessageType.Binary, true, CancellationToken.None);
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"WS Error: {ex.Message}");
                    }
                }
                else if (result.MessageType == WebSocketMessageType.Close)
                {
                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closed", CancellationToken.None);
                }
            }
        }

        public class ImageRequest
        {
            public int requestId { get; set; }
            public string fileId { get; set; } = "";
            public int size { get; set; }
        }
    }
}