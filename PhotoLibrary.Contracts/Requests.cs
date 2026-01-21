using System;

namespace PhotoLibrary.Backend;

public record FileIdRequest(string fileEntryId);
public record CollectionIdRequest(string collectionId);
public record TaskRequest(string taskId);
public record NameRequest(string name);
public record PickRequest(string fileEntryId, bool isPicked);
public record RateRequest(string fileEntryId, int rating);
public record SearchRequest(string? tag, string? value, string? query);
public record CollectionAddRequest(string collectionId, string[] fileEntryIds);
public record ZipRequest(string[] fileEntryIds, string type, string? name);
public record SettingRequest(string key, string value);
public record ImportBatchRequest(string rootPath, string[] relativePaths, bool generateLow, bool generateMedium);
public record GenerateThumbnailsRequest(string rootId, bool recursive, bool force);
public record FolderAnnotationRequest(string folderId, string annotation, string? color);
public record ForceUpdatePreviewRequest(string fileEntryId);
public record PagedPhotosRequest(int? limit, int? offset, string? rootId, bool? pickedOnly, int? rating, string[]? specificFileEntryIds, bool? stacked);
public record ImageRequest { public int requestId { get; init; } public string fileEntryId { get; init; } = ""; public int size { get; init; } public double priority { get; init; } }