using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Data.Sqlite;
using ImageMagick;

namespace MigrationUtil
{
    class Program
    {
        private record SourceData(string Hash, byte[] Data, int OriginalSize);

        static void Main(string[] args)
        {
            string configDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "PhotoLibrary");
            string previewDbPath = Path.Combine(configDir, "previews.db");

            if (args.Length > 0) previewDbPath = args[0];

            if (!File.Exists(previewDbPath))
            {
                Console.WriteLine($"Previews database not found at {previewDbPath}");
                return;
            }

            Console.WriteLine($"Starting robust migration of {previewDbPath} to WebP (Quality 80)...");

            string connectionString = $"Data Source={previewDbPath}";
            
            // 1. Load all potential sources into memory to allow table truncation
            var sources = new List<SourceData>();
            using (var connection = new SqliteConnection(connectionString))
            {
                connection.Open();
                Console.WriteLine("Reading existing previews...");
                using (var cmd = connection.CreateCommand())
                {
                    // Prefer 1024 as source, but take 300 if it's all we have
                    cmd.CommandText = @"
                        SELECT Hash, Data, LongEdge 
                        FROM Previews 
                        WHERE (Hash, LongEdge) IN (
                            SELECT Hash, MAX(LongEdge) 
                            FROM Previews 
                            GROUP BY Hash
                        )";
                    using var reader = cmd.ExecuteReader();
                    while (reader.Read())
                    {
                        sources.Add(new SourceData(reader.GetString(0), (byte[])reader[1], reader.GetInt32(2)));
                    }
                }
            }

            Console.WriteLine($"Found {sources.Count} unique images. Total source data: {sources.Sum(s => (long)s.Data.Length) / (1024.0 * 1024.0):F2} MB");

            // 2. Clear the table to ensure no old thumbs remain
            using (var connection = new SqliteConnection(connectionString))
            {
                connection.Open();
                Console.WriteLine("Truncating Previews table for a fresh start...");
                using (var cmd = connection.CreateCommand())
                {
                    cmd.CommandText = "DELETE FROM Previews";
                    cmd.ExecuteNonQuery();
                }

                int count = 0;
                foreach (var source in sources)
                {
                    try
                    {
                        using (var image = new MagickImage(source.Data))
                        {
                            image.Format = MagickFormat.WebP;
                            image.Quality = 80;

                            // Save 1024px WebP
                            using (var med = image.Clone())
                            {
                                if (med.Width > 1024 || med.Height > 1024)
                                {
                                    if (med.Width > med.Height) med.Resize(1024, 0);
                                    else med.Resize(0, 1024);
                                }
                                byte[] webp1024 = med.ToByteArray();
                                SavePreview(connection, source.Hash, 1024, webp1024);
                            }

                            // Save 300px WebP
                            using (var thumb = image.Clone())
                            {
                                if (thumb.Width > thumb.Height) thumb.Resize(300, 0);
                                else thumb.Resize(0, 300);
                                
                                byte[] webp300 = thumb.ToByteArray();
                                SavePreview(connection, source.Hash, 300, webp300);
                            }
                        }

                        count++;
                        if (count % 50 == 0)
                        {
                            long currentSize = new FileInfo(previewDbPath).Length;
                            Console.WriteLine($"Migrated {count}/{sources.Count}... DB Size: {currentSize / (1024.0 * 1024.0):F2} MB");
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"Error migrating hash {source.Hash}: {ex.Message}");
                    }
                }

                Console.WriteLine("Migration complete. Compact/Vacuuming database...");
                using (var cmd = connection.CreateCommand())
                {
                    cmd.CommandText = "VACUUM";
                    cmd.ExecuteNonQuery();
                }
            }
            
            long finalSize = new FileInfo(previewDbPath).Length;
            Console.WriteLine($"Final DB Size: {finalSize / (1024.0 * 1024.0):F2} MB. Done.");
        }

        static void SavePreview(SqliteConnection connection, string hash, int longEdge, byte[] data)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = "INSERT INTO Previews (Hash, LongEdge, Data) VALUES ($Hash, $LongEdge, $Data)";
            cmd.Parameters.AddWithValue("$Hash", hash);
            cmd.Parameters.AddWithValue("$LongEdge", longEdge);
            cmd.Parameters.AddWithValue("$Data", data);
            cmd.ExecuteNonQuery();
        }
    }
}
