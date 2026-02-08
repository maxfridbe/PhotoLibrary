using System;
using System.IO;
using Xunit;

namespace PhotoLibrary.Backend.Tests;

public class UtilityTests : TestBase
{
    [Theory]
    [InlineData("/home/user/photos", "/home/user/photos/vacation/p1.jpg", true)]
    [InlineData("/home/user/photos", "/home/user/photos/../secret.txt", false)]
    [InlineData("/home/user/photos", "/etc/passwd", false)]
    [InlineData("/tmp/test", "/tmp/test/image.jpg", true)]
    [InlineData("/tmp/test", "/tmp/other/image.jpg", false)]
    public void IsPathInside_ShouldCorrectlyValidate(string root, string path, bool expected)
    {
        // Act
        bool result = PathUtils.IsPathInside(root, path);

        // Assert
        Assert.Equal(expected, result);
    }

    [Fact]
    public void ResolvePath_ShouldHandleTilde()
    {
        // Act
        string resolved = PathUtils.ResolvePath("~/test");

        // Assert
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        Assert.Equal(Path.Combine(home, "test"), resolved);
    }
}
