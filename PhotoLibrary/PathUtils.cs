using System;
using System.IO;

namespace PhotoLibrary
{
    public static class PathUtils
    {
        public static string ResolvePath(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;
            
            string resolved = path;
            if (path.StartsWith("~"))
            {
                resolved = path.Replace("~", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            }

            // Resilience for Linux /home -> /var/home symlinks
            if (resolved.StartsWith("/home/") && !Directory.Exists("/home"))
            {
                if (Directory.Exists("/var/home"))
                {
                    resolved = "/var/home/" + resolved.Substring(6);
                }
            }

            return Path.GetFullPath(resolved);
        }
    }
}
