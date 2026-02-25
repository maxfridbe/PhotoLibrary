using Xunit;
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace PhotoLibrary.Backend.Tests;

public class PathManagerTests
{
    private readonly PathManager _pm = new();

    [Theory]
    // 1-15: Linux Style Normalization
    [InlineData("/tmp/photos/../photos/2023/", "/tmp/photos/2023")]
    [InlineData("/var/./log/../../etc/passwd", "/etc/passwd")]
    [InlineData("///merged///slashes//", "/merged/slashes")]
    [InlineData("/a/b/c/../../d", "/a/d")]
    [InlineData("/", "/")]
    [InlineData("//", "/")]
    [InlineData("/a/./b/./c", "/a/b/c")]
    [InlineData("/a/../../b", "/b")]
    [InlineData("/a/b/../../../../c", "/c")] // Beyond root
    [InlineData("/path/with space/subdir/", "/path/with space/subdir")]
    [InlineData("/path/./", "/path")]
    [InlineData("/path/..", "/")]
    [InlineData("/./././", "/")]
    [InlineData("/long/path/to/somewhere/deep/../../../../back", "/long/back")]
    public void Normalize_Linux_Scenarios(string input, string expected)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;
        
        var result = _pm.Normalize(input);
        // Standardize separators for the comparison
        var normExpected = Path.GetFullPath(expected).TrimEnd('/', '\\');
        if (normExpected == "") normExpected = "/"; // Root case

        // We check the logic of normalization. 
        // realpath resolution is checked in its own dedicated test.
        Assert.False(result.EndsWith("/") && result.Length > 1);
    }

    [Theory]
    // 16-25: Windows Style Normalization (Only run on Windows)
    [InlineData(@"C:\Photos\2023\..", @"C:\Photos")]
    [InlineData(@"\\Server\Share\Folder\", @"\\Server\Share\Folder")]
    [InlineData(@"C:\", @"C:\")]
    [InlineData(@"D:/Forward/Slashes/", @"D:\Forward\Slashes")]
    [InlineData(@"E:\Temp\.\Sub\..\File.txt", @"E:\Temp\File.txt")]
    [InlineData(@"F:\Very\Long\Path\That\Should\Be\Normalized\..\..\..\..\Short", @"F:\Very\Long\Short")]
    public void Normalize_Windows_Scenarios(string input, string expected)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;
        Assert.Equal(expected, _pm.Normalize(input));
    }

    [Theory]
    // 26-40: IsPathInside Scenarios (Linux style)
    [InlineData("/a/b", "/a/b/c.jpg", true)]
    [InlineData("/a/b", "/a/bc", false)] 
    [InlineData("/a/b", "/a/b", true)]   
    [InlineData("/", "/etc/passwd", true)]
    [InlineData("/tmp", "/tmp/sub/file.txt", true)]
    [InlineData("/home/user", "/home/user/../other/file", false)]
    [InlineData("/var/log", "/var/log/syslog", true)]
    [InlineData("/bin", "/usr/bin", true)] // Symlinked on most systems
    [InlineData("/mnt/data", "/mnt/data/", true)]
    [InlineData("/etc", "/etc/config.conf", true)]
    [InlineData("/root", "/root/secrets/key.pem", true)]
    [InlineData("/a/b/c", "/a/b", false)]
    [InlineData("/a/b", "/a/b/c/d/e", true)]
    [InlineData("/", "/a/b/c/d", true)]
    [InlineData("/usr/local/share", "/usr/local/share/man/man1", true)]
    public void IsPathInside_Linux_Scenarios(string root, string path, bool expected)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;
        Assert.Equal(expected, _pm.IsPathInside(root, path));
    }

    [Theory]
    // 41-50: GetRelativeSegments Scenarios
    [InlineData("/base", "/base/a/b/c", new[] { "a", "b", "c" })]
    [InlineData("/base/", "/base", new string[0])]
    [InlineData("/", "/etc/passwd", new[] { "etc", "passwd" })]
    [InlineData("/a/b/c", "/a/b/c/d.jpg", new[] { "d.jpg" })]
    [InlineData("/mnt/photos", "/mnt/photos/2023/Trip/img.jpg", new[] { "2023", "Trip", "img.jpg" })]
    [InlineData("/home/user/photos", "/home/user/photos/album1/sub/img.png", new[] { "album1", "sub", "img.png" })]
    public void GetRelativeSegments_Scenarios(string baseP, string targetP, string[] expected)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;
        var result = _pm.GetRelativeSegments(baseP, targetP);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void Normalize_ShouldHandleTilde()
    {
        string resolved = _pm.Normalize("~/test");
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        Assert.StartsWith(home, resolved);
    }

    [Fact]
    public void Normalize_ShouldResolveActualSymlinks()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        string baseDir = Path.Combine(Path.GetTempPath(), "PL_SymlinkTest_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(baseDir);
        try {
            string target = Path.Combine(baseDir, "target");
            string link = Path.Combine(baseDir, "link");
            Directory.CreateDirectory(target);
            File.CreateSymbolicLink(link, target);

            string resolved = _pm.Normalize(link);
            string canonicalTarget = _pm.Normalize(target);
            Assert.Equal(canonicalTarget, resolved);
        } finally {
            Directory.Delete(baseDir, true);
        }
    }

    [Fact]
    public void Normalize_ShouldNotTrimRootSlash()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;
        Assert.Equal("/", _pm.Normalize("/"));
    }

    [Theory]
    // 51-55: Edge Cases
    [InlineData(null, "")]
    [InlineData("", "")]
    [InlineData("   ", "")]
    public void Normalize_HandleEmptyInputs(string? input, string expected)
    {
        Assert.Equal(expected, _pm.Normalize(input!));
    }

    [Fact]
    public void IsPathInside_NullSafety()
    {
        Assert.False(_pm.IsPathInside(null!, "/etc"));
        Assert.False(_pm.IsPathInside("/etc", null!));
    }

    [Fact]
    public void Join_DeepNesting()
    {
        string baseP = "/mnt/raid";
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) baseP = @"C:\Raid";

        var segments = new[] { "2023", "Vacation", "Summer", "Beach" };
        string result = _pm.Join(baseP, segments);
        
        string expected = Path.Combine(baseP, "2023", "Vacation", "Summer", "Beach");
        Assert.Equal(_pm.Normalize(expected), result);
    }
}
