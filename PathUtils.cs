using System;
using System.IO;

namespace PhotoLibrary
{
    public static class PathUtils
    {
        public static string ResolvePath(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;
            
            if (path.StartsWith("~"))
            {
                return Path.GetFullPath(path.Replace("~", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)));
            }
            return Path.GetFullPath(path);
        }
    }
}
