using System;

namespace PhotoLibrary.Backend;

public interface ICameraManager
{
    byte[]? GetCameraThumbnail(string model);
}
