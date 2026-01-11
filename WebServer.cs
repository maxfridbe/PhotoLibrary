using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using System.Linq;

namespace PhotoLibrary
{
    public static class WebServer
    {
        public static void Start(int port, string libraryPath, string previewPath)
        {
            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseUrls($"http://*:{port}");

            // Register services
            builder.Services.AddSingleton(new DatabaseManager(libraryPath));
            builder.Services.AddSingleton(new PreviewManager(previewPath));

            var app = builder.Build();

            // API: Get Photos
            app.MapGet("/api/photos", (DatabaseManager db) =>
            {
                var photos = db.GetAllPhotos();
                return Results.Ok(photos);
            });

            // API: Get Preview
            app.MapGet("/api/preview/{id}/{size}", (string id, int size, PreviewManager pm) =>
            {
                var data = pm.GetPreviewData(id, size);
                if (data == null) return Results.NotFound();
                return Results.Bytes(data, "image/jpeg");
            });

            // UI: Home
            app.MapGet("/", () => Results.Content(HtmlContent, "text/html"));

            Console.WriteLine($"Web server running on port {port}");
            app.Run();
        }

        private const string HtmlContent = @"
<!DOCTYPE html>
<html lang='en'>
<head>
    <meta charset='UTF-8'>
    <meta name='viewport' content='width=device-width, initial-scale=1.0'>
    <title>Photo Library</title>
    <style>
        body { margin: 0; background: #1e1e1e; color: #ddd; font-family: sans-serif; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; padding: 10px; }
        .card { background: #2b2b2b; border-radius: 4px; overflow: hidden; display: flex; flex-direction: column; }
        .img-container { height: 200px; background: #000; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .img-container img { max-width: 100%; max-height: 100%; object-fit: contain; }
        .info { padding: 8px; font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .date { color: #888; font-size: 0.8em; }
    </style>
</head>
<body>
    <div id='app' class='grid'>Loading...</div>

    <script>
        async function load() {
            const res = await fetch('/api/photos');
            const photos = await res.json();
            const app = document.getElementById('app');
            app.innerHTML = '';

            photos.forEach(p => {
                const card = document.createElement('div');
                card.className = 'card';
                
                // Prefer 300px preview, fallback if needed logic can be added
                const imgUrl = `/api/preview/${p.id}/300`;
                
                card.innerHTML = `
                    <div class='img-container'>
                        <img src='${imgUrl}' loading='lazy' alt='${p.fileName}' />
                    </div>
                    <div class='info'>
                        <div>${p.fileName}</div>
                        <div class='date'>${new Date(p.createdAt).toLocaleDateString()}</div>
                    </div>
                `;
                app.appendChild(card);
            });
        }
        load();
    </script>
</body>
</html>";
    }
}
