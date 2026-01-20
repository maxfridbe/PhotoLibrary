using System;
using System.Collections.Generic;

namespace PhotoLibrary.Backend;

public record RpcResult<T>(T? Data, bool Success = true, string? Error = null);

public record FileResult(byte[] Data);
public record PhysicalFileResult(string FullPath, string FileName);

public record ExportInfo(string FullPath, int Rotation, bool IsHidden);