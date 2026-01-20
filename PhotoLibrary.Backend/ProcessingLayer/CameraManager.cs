using System;
using System.IO;
using System.Reflection;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace PhotoLibrary.Backend;

public class CameraManager : ICameraManager
{
    private readonly string _dbPath;
    private readonly string _connectionString;
    private readonly ILogger<CameraManager> _logger;

    private static readonly Dictionary<string, string> _modelAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        { "ILCE-7", "Sony a7" },
        { "ILCE-7M2", "Sony a7 II" },
        { "ILCE-7M3", "Sony a7 III" },
        { "ILCE-7M4", "Sony a7 IV" },
        { "ILCE-7R", "Sony a7R" },
        { "ILCE-7RM2", "Sony a7R II" },
        { "ILCE-7RM3", "Sony a7R III" },
        { "ILCE-7RM4", "Sony a7R IV" },
        { "ILCE-7S", "Sony a7S" },
        { "ILCE-7SM2", "Sony a7S II" },
        { "ILCE-7SM3", "Sony a7S III" },
        { "ILCE-7C", "Sony a7C" },
        { "ILCE-7CM2", "Sony a7C II" },
        { "ILCE-7CR", "Sony a7CR" },
        { "ILCE-9", "Sony a9" },
        { "ILCE-9M2", "Sony a9 II" },
        { "ILCE-9M3", "Sony a9 III" },
        { "ILCE-1", "Sony a1" },
        { "ILCE-5000", "Sony a5000" },
        { "ILCE-5100", "Sony a5100" },
        { "ILCE-6000", "Sony a6000" },
        { "ILCE-6100", "Sony a6100" },
        { "ILCE-6300", "Sony a6300" },
        { "ILCE-6400", "Sony a6400" },
        { "ILCE-6500", "Sony a6500" },
        { "ILCE-6600", "Sony a6600" },
        { "ILCE-6700", "Sony a6700" }
    };

    public CameraManager(string configDir, ILogger<CameraManager> logger)
    {
        _logger = logger;
        _dbPath = Path.Combine(configDir, "cameras.db");
        _connectionString = $"Data Source={_dbPath}";
        Initialize();
    }

    private void Initialize()
    {
        try
        {
            // Always re-extract to ensure we have the latest embedded data
            _logger.LogInformation("Updating cameras.db at {Path}", _dbPath);
            ExtractResource("PhotoLibrary.cameras.db", _dbPath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to initialize CameraManager");
        }
    }

    private void ExtractResource(string resourceName, string outputPath)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName);
        if (stream == null)
        {
            _logger.LogError("Embedded resource {ResourceName} not found", resourceName);
            return;
        }
        using var fileStream = File.Create(outputPath);
        stream.CopyTo(fileStream);
    }

    public byte[]? GetCameraThumbnail(string model)
    {
        if (!File.Exists(_dbPath)) return null;

        string search = CleanModelName(model).ToLowerInvariant();
        
        // Try alias lookup
        string lookup = model.ToUpperInvariant().Replace("SONY", "").Trim();
        if (_modelAliases.TryGetValue(lookup, out var alias))
        {
            search = CleanModelName(alias).ToLowerInvariant();
        }

        try
        {
            using var connection = new SqliteConnection(_connectionString);
            connection.Open();

            // 1. Try exact match on cleaned name
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT thumbnail_blob FROM cameras WHERE LOWER(model) = $S OR LOWER(name) = $S LIMIT 1";
                command.Parameters.AddWithValue("$S", search);
                using var reader = command.ExecuteReader();
                if (reader.Read() && !reader.IsDBNull(0)) return (byte[])reader[0];
            }

            // 2. Fetch all candidates
            var candidates = new List<(string Name, string Model, byte[] Blob)>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT name, model, thumbnail_blob FROM cameras WHERE thumbnail_blob IS NOT NULL";
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    candidates.Add((reader.GetString(0), reader.GetString(1), (byte[])reader[2]));
                }
            }

            (byte[]? bestBlob, int bestScore) = (null, -1);

            foreach (var c in candidates)
            {
                int score = CalculateMatchScore(search, CleanModelName(c.Name).ToLowerInvariant(), CleanModelName(c.Model).ToLowerInvariant());
                if (score > bestScore)
                {
                    bestScore = score;
                    bestBlob = c.Blob;
                }
            }

            if (bestScore > 60) return bestBlob;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching camera thumbnail for {Model}", model);
        }

        return null;
    }

    private string CleanModelName(string name)
    {
        if (string.IsNullOrEmpty(name)) return "";
        return name.Replace("NIKON CORPORATION", "Nikon")
                   .Replace("NIKON", "Nikon")
                   .Replace("SONY CORPORATION", "Sony")
                   .Replace("CANON INC.", "Canon")
                   .Replace("CORPORATION", "")
                   .Replace("INC.", "")
                   .Trim();
    }

    private int CalculateMatchScore(string search, string candName, string candModel)
    {
        if (search == candName || search == candModel) return 100;
        
        var searchTokens = search.Split(new[] { ' ', '-', '_' }, StringSplitOptions.RemoveEmptyEntries);
        int matches = 0;
        foreach (var st in searchTokens)
        {
            if (st.Length < 2) continue;
            if (candName.Contains(st) || candModel.Contains(st)) matches++;
        }

        if (matches == 0) return 0;

        int score = (int)((float)matches / searchTokens.Length * 100);
        
        if (!string.IsNullOrEmpty(candModel) && search.Contains(candModel)) score += 20;
        if (!string.IsNullOrEmpty(candName) && search.Contains(candName)) score += 10;

        return Math.Min(score, 100);
    }
}