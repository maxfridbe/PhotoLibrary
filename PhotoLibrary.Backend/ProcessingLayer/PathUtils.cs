using System;
using System.IO;

namespace PhotoLibrary.Backend;

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

#if !WINDOWS
        // Resilience for Linux /home -> /var/home symlinks
        if (resolved.StartsWith("/home/") && !Directory.Exists("/home"))
        {
            if (Directory.Exists("/var/home"))
            {
                resolved = "/var/home/" + resolved.Substring(6);
            }
        }
#endif

        return Path.GetFullPath(resolved);
    }

    public static bool IsPathInside(string root, string path)
    {
        if (string.IsNullOrEmpty(root) || string.IsNullOrEmpty(path)) return false;

        try
        {
            string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string fullPath = Path.GetFullPath(path);

            // On Windows, drive letters and case matter. On Linux, case usually matters.
            // Using StartsWith with the appropriate comparison.
            return fullPath.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || 
                   fullPath.StartsWith(fullRoot + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                   fullPath.Equals(fullRoot, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }
}