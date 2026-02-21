using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace PhotoLibrary.Backend;

public interface ICommunicationLayer
{
    ApplicationSettingsResponse GetApplicationSettings();
    FileResult? GetCameraThumbnail(string model);
    PagedPhotosResponse GetPhotosPaged(PagedPhotosRequest req);
    List<MetadataGroupResponse> GetMetadata(FileIdRequest req);
    List<DirectoryNodeResponse> GetDirectories();
    LibraryInfoResponse GetLibraryInfo();
    RpcResult<string> BackupLibrary();
    Task SetPicked(PickRequest req);
    Task SetRating(RateRequest req);
    IEnumerable<string> Search(SearchRequest req);
    IEnumerable<CollectionResponse> GetCollections();
    CollectionCreatedResponse CreateCollection(NameRequest req);
    void DeleteCollection(CollectionIdRequest req);
    void AddFilesToCollection(CollectionAddRequest req);
    IEnumerable<string> GetCollectionFiles(CollectionIdRequest req);
    void ClearPicked();
    IEnumerable<string> GetPickedIds();
    PagedMapPhotoResponse GetMapPhotos();
    PagedPhotosResponse GetGeotaggedPhotosPaged(PagedMapPhotosRequest req);
    StatsResponse GetStats();
    List<DirectoryResponse> ListFileSystem(NameRequest req);
    List<ScanFileResult> FindFiles(FindFilesRequest req);
    List<string> FindNewFiles(NameRequest req);
    ValidateImportResponse ValidateImport(ValidateImportRequest req);
    void ImportBatch(ImportBatchRequest req);
    string ImportLocal(ImportLocalRequest req);
    void GenerateThumbnails(GenerateThumbnailsRequest req, Action<ImageRequest, CancellationToken> enqueue);
    void SetAnnotation(FolderAnnotationRequest req);
    void ForceUpdatePreview(ForceUpdatePreviewRequest req, Action<ImageRequest, CancellationToken> enqueue);
    void ForgetRoot(ForgetRootRequest req);
    bool CancelTask(TaskRequest req);
    string? GetSetting(string key);
    void SetSetting(SettingRequest req);
    string PrepareExport(ZipRequest req);
    string? GetExportZipName(string token);
    Task DownloadExport(string token, Stream outputStream);
    PhysicalFileResult? DownloadFile(string fileEntryId);
    Task<byte[]> GetImageAsync(ImageRequest req, CancellationToken ct);
    Task<byte[]?> GetMapTileAsync(int z, int x, int y);
    Task Broadcast(object message, string? targetClientId = null);
}
