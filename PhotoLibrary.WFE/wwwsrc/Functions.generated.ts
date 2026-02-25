// Generated from PhotoLibrary.WFE/WebServer.cs via Roslyn
import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';

async function post<T>(url: string, data: any = {}): Promise<T> {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {} as T;
}

async function postBlob(url: string, data: any = {}): Promise<Blob> {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
    return await res.blob();
}

export async function api_get_application_settings(): Promise<Res.ApplicationSettingsResponse> {
    return await post('/api/get-application-settings');
}

export async function api_camera_thumbnail(data: Req.NameRequest): Promise<Blob> {
    return await postBlob('/api/camera/thumbnail', data);
}

export async function api_photos(data: Req.PagedPhotosRequest): Promise<Res.PagedPhotosResponse> {
    return await post('/api/photos', data);
}

export async function api_metadata(data: Req.FileIdRequest): Promise<Res.MetadataGroupResponse[]> {
    return await post('/api/metadata', data);
}

export async function api_directories(): Promise<Res.DirectoryNodeResponse[]> {
    return await post('/api/directories');
}

export async function api_library_info(): Promise<Res.LibraryInfoResponse> {
    return await post('/api/library/info');
}

export async function api_library_backup(): Promise<any> {
    return await post('/api/library/backup');
}

export async function api_pick(data: Req.PickRequest): Promise<any> {
    return await post('/api/pick', data);
}

export async function api_rate(data: Req.RateRequest): Promise<any> {
    return await post('/api/rate', data);
}

export async function api_search(data: Req.SearchRequest): Promise<string[]> {
    return await post('/api/search', data);
}

export async function api_collections_list(): Promise<Res.CollectionResponse[]> {
    return await post('/api/collections/list');
}

export async function api_collections_create(data: Req.NameRequest): Promise<any> {
    return await post('/api/collections/create', data);
}

export async function api_collections_delete(data: Req.CollectionIdRequest): Promise<any> {
    return await post('/api/collections/delete', data);
}

export async function api_collections_add_files(data: Req.CollectionAddRequest): Promise<any> {
    return await post('/api/collections/add-files', data);
}

export async function api_collections_get_files(data: Req.CollectionIdRequest): Promise<string[]> {
    return await post('/api/collections/get-files', data);
}

export async function api_picked_clear(): Promise<any> {
    return await post('/api/picked/clear');
}

export async function api_picked_ids(): Promise<string[]> {
    return await post('/api/picked/ids');
}

export async function api_map_photos(): Promise<Res.PagedMapPhotoResponse> {
    return await post('/api/map/photos');
}

export async function api_photos_geotagged(data: Req.PagedMapPhotosRequest): Promise<Res.PagedPhotosResponse> {
    return await post('/api/photos/geotagged', data);
}

export async function api_stats(): Promise<Res.StatsResponse> {
    return await post('/api/stats');
}

export async function api_fs_list(data: Req.NameRequest): Promise<Res.DirectoryResponse[]> {
    return await post('/api/fs/list', data);
}

export async function api_fs_find_files(data: Req.FindFilesRequest): Promise<any> {
    return await post('/api/fs/find-files', data);
}

export async function api_library_find_new_files(data: Req.NameRequest): Promise<any> {
    return await post('/api/library/find-new-files', data);
}

export async function api_library_validate_import(data: Req.ValidateImportRequest): Promise<Res.ValidateImportResponse> {
    return await post('/api/library/validate-import', data);
}

export async function api_library_import_batch(data: Req.ImportBatchRequest): Promise<any> {
    return await post('/api/library/import-batch', data);
}

export async function api_library_import_local(data: Req.ImportLocalRequest): Promise<any> {
    return await post('/api/library/import-local', data);
}

export async function api_library_generate_thumbnails(data: Req.GenerateThumbnailsRequest): Promise<Blob> {
    return await postBlob('/api/library/generate-thumbnails', data);
}

export async function api_library_set_annotation(data: Req.FolderAnnotationRequest): Promise<any> {
    return await post('/api/library/set-annotation', data);
}

export async function api_library_force_update_preview(data: Req.ForceUpdatePreviewRequest): Promise<any> {
    return await post('/api/library/force-update-preview', data);
}

export async function api_library_forget_root(data: Req.ForgetRootRequest): Promise<any> {
    return await post('/api/library/forget-root', data);
}

export async function api_library_repair(): Promise<any> {
    return await post('/api/library/repair');
}

export async function api_library_cancel_task(data: Req.TaskRequest): Promise<{ success: boolean }> {
    return await post('/api/library/cancel-task', data);
}

export async function api_settings_get(data: Req.NameRequest): Promise<{ value: string | null }> {
    return await post('/api/settings/get', data);
}

export async function api_settings_set(data: Req.SettingRequest): Promise<any> {
    return await post('/api/settings/set', data);
}

export async function api_export_prepare(data: Req.ZipRequest): Promise<{ token: string }> {
    return await post('/api/export/prepare', data);
}

