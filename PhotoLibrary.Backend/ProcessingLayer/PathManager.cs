using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

using System.Runtime.InteropServices;

namespace PhotoLibrary.Backend;

/// <summary>
/// A focused, testable manager for all path-related logic.
/// Replaces sprawling path logic across the codebase.
/// </summary>
public class PathManager
{
    private readonly char[] _separators = { '/', '\\' };

    [DllImport("libc", EntryPoint = "realpath", CharSet = CharSet.Ansi)]
    private static extern IntPtr realpath(string path, IntPtr resolved_path);

    /// <summary>
    /// Normalizes a path to use consistent separators, resolves relative components,
    /// and follows symlinks to ensure a canonical physical path.
    /// </summary>
    public string Normalize(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return string.Empty;
        
        string resolved = path;
        // 1. Handle ~
        if (resolved.StartsWith("~"))
        {
            resolved = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), resolved.TrimStart('~').TrimStart('/', '\\'));
        }

        // 2. Standard .NET normalization (resolves .. and .)
        resolved = Path.GetFullPath(resolved);

        // 3. Dynamic Symlink Resolution (Linux/macOS)
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            IntPtr ptr = realpath(resolved, IntPtr.Zero);
            if (ptr != IntPtr.Zero)
            {
                try {
                    resolved = Marshal.PtrToStringAnsi(ptr) ?? resolved;
                } finally {
                    Marshal.FreeHGlobal(ptr);
                }
            }
        }

        // 4. Final normalization: Trim trailing slashes, but NEVER trim the root itself
        string root = Path.GetPathRoot(resolved) ?? "";
        if (resolved.Length > root.Length)
        {
            // Use both types of slashes for trimming regardless of current OS
            resolved = resolved.TrimEnd('/', '\\');
            // If we trimmed everything down to empty (unlikely with GetFullPath), return root
            if (string.IsNullOrEmpty(resolved)) return root;
        }
        else
        {
            // It IS a root (like "/" or "C:\"). Ensure it's returned exactly as GetFullPath likes it.
            return resolved;
        }
        
        return resolved;
    }

    /// <summary>
    /// Splits an absolute path into segments from a given base.
    /// Example: /mnt/photos/2023/NYC with base /mnt/photos -> ["2023", "NYC"]
    /// </summary>
    public List<string> GetRelativeSegments(string basePath, string targetPath)
    {
        basePath = Normalize(basePath);
        targetPath = Normalize(targetPath);

        if (!targetPath.StartsWith(basePath, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException($"Target path '{targetPath}' is not under base path '{basePath}'");
        }

        string relative = Path.GetRelativePath(basePath, targetPath);
        if (relative == ".") return new List<string>();

        return relative.Split(_separators, StringSplitOptions.RemoveEmptyEntries).ToList();
    }

    /// <summary>
    /// Returns a normalized relative path string from basePath to targetPath.
    /// Example: /mnt/photos and /mnt/photos/2023/img.jpg -> 2023/img.jpg
    /// </summary>
    public string GetRelativePath(string basePath, string targetPath)
    {
        var segments = GetRelativeSegments(basePath, targetPath);
        if (segments.Count == 0) return string.Empty;
        return string.Join("/", segments); // We standardize on forward slashes for cross-platform DB/UI usage
    }

    /// <summary>
    /// Reconstructs a full path from a list of segments and a base.
    /// </summary>
    public string Join(string basePath, IEnumerable<string> segments)
    {
        string current = Normalize(basePath);
        foreach (var segment in segments)
        {
            current = Path.Combine(current, segment);
        }
        return current;
    }

    /// <summary>
    /// Returns the directory part of a full file path.
    /// </summary>
    public string GetDirectoryPath(string fullFilePath)
    {
        return Path.GetDirectoryName(Normalize(fullFilePath)) ?? string.Empty;
    }

    /// <summary>
    /// Returns true if 'targetPath' is inside or equal to 'basePath'.
    /// </summary>
    public bool IsPathInside(string basePath, string targetPath)
    {
        if (string.IsNullOrEmpty(basePath) || string.IsNullOrEmpty(targetPath)) return false;
        
        string normBase = Normalize(basePath);
        string normTarget = Normalize(targetPath);

        if (normTarget.Equals(normBase, StringComparison.OrdinalIgnoreCase)) return true;

        // Ensure base ends with separator for accurate containment check
        string baseWithSeparator = normBase;
        if (!baseWithSeparator.EndsWith(Path.DirectorySeparatorChar) && !baseWithSeparator.EndsWith(Path.AltDirectorySeparatorChar))
        {
            baseWithSeparator += Path.DirectorySeparatorChar;
        }

        return normTarget.StartsWith(baseWithSeparator, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Static-style resolver for entry points like Program.cs or areas where 
    /// instantiation is inconvenient.
    /// </summary>
    public static string Resolve(string path)
    {
        return new PathManager().Normalize(path);
    }
}
