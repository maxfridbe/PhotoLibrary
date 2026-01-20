using System;

namespace PhotoLibrary.Backend;

public record IdRequest(string id);
public record NameRequest(string name);
public record PickRequest(string id, bool isPicked);
public record RateRequest(string id, int rating);
public record SearchRequest(string? tag, string? value, string? query);
public record CollectionAddRequest(string collectionId, string[] fileIds);
public record ZipRequest(string[] fileIds, string type, string? name);
public record SettingRequest(string key, string value);
public record ImportBatchRequest(string rootPath, string[] relativePaths, bool generateLow, bool generateMedium);
public record GenerateThumbnailsRequest(string rootId, bool recursive, bool force);
public record FolderAnnotationRequest(string folderId, string annotation, string? color);
public record ForceUpdatePreviewRequest(string id);
public record PagedPhotosRequest(int? limit, int? offset, string? rootId, bool? pickedOnly, int? rating, string[]? specificIds, bool? stacked);
public class ImageRequest { public int requestId { get; set; } public string fileId { get; set; } = ""; public int size { get; set; } public double priority { get; set; } }