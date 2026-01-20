using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace PhotoLibrary.Backend;

public interface ICommunicationLayer
{
    FileResult? GetCameraThumbnail(string model);
    PagedPhotosResponse GetPhotosPaged(PagedPhotosRequest req);
    List<MetadataGroupResponse> GetMetadata(IdRequest req);
    List<DirectoryNodeResponse> GetDirectories();
    LibraryInfoResponse GetLibraryInfo();
    RpcResult<string> BackupLibrary();
    Task SetPicked(PickRequest req);
    Task SetRating(RateRequest req);
    IEnumerable<string> Search(SearchRequest req);
    IEnumerable<object> GetCollections();
    object CreateCollection(NameRequest req);
    void DeleteCollection(IdRequest req);
    void AddFilesToCollection(CollectionAddRequest req);
    IEnumerable<string> GetCollectionFiles(IdRequest req);
    void ClearPicked();
    IEnumerable<string> GetPickedIds();
    StatsResponse GetStats();
    List<DirectoryResponse> ListFileSystem(NameRequest req);
    List<string> FindFiles(NameRequest req);
    List<string> FindNewFiles(NameRequest req);
    void ImportBatch(ImportBatchRequest req);
    void GenerateThumbnails(GenerateThumbnailsRequest req, Action<ImageRequest, CancellationToken> enqueue);
    void SetAnnotation(FolderAnnotationRequest req);
    void ForceUpdatePreview(ForceUpdatePreviewRequest req, Action<ImageRequest, CancellationToken> enqueue);
    bool CancelTask(IdRequest req);
    string? GetSetting(string key);
    void SetSetting(SettingRequest req);
    string PrepareExport(ZipRequest req);
    string? GetExportZipName(string token);
    Task DownloadExport(string token, Stream outputStream);
    PhysicalFileResult? DownloadFile(string fileId);
}
