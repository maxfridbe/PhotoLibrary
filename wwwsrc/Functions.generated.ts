// Generated from WebServer.cs via Roslyn at 2026-01-12T13:32:49.2492279-06:00
import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';

async function post<T>(url: string, data: any = {}): Promise<T> {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {} as T;
}

export async function api_photos(data: any): Promise<Res.PagedPhotosResponse> {
    return await post<Res.PagedPhotosResponse>('/api/photos', data);
}

export async function api_metadata(data: any): Promise<Res.MetadataItemResponse[]> {
    return await post<Res.MetadataItemResponse[]>('/api/metadata', data);
}

export async function api_directories(data: any): Promise<Res.RootPathResponse[]> {
    return await post<Res.RootPathResponse[]>('/api/directories', data);
}

export async function api_library_info(data: any): Promise<any> {
    return await post<any>('/api/library/info', data);
}

export async function api_pick(data: any): Promise<any> {
    return await post<any>('/api/pick', data);
}

export async function api_rate(data: any): Promise<any> {
    return await post<any>('/api/rate', data);
}

export async function api_search(data: any): Promise<string[]> {
    return await post<string[]>('/api/search', data);
}

export async function api_collections_list(data: any): Promise<Res.CollectionResponse[]> {
    return await post<Res.CollectionResponse[]>('/api/collections/list', data);
}

export async function api_collections_create(data: any): Promise<any> {
    return await post<any>('/api/collections/create', data);
}

export async function api_collections_delete(data: any): Promise<any> {
    return await post<any>('/api/collections/delete', data);
}

export async function api_collections_add_files(data: any): Promise<any> {
    return await post<any>('/api/collections/add-files', data);
}

export async function api_collections_get_files(data: any): Promise<string[]> {
    return await post<string[]>('/api/collections/get-files', data);
}

export async function api_picked_clear(data: any): Promise<any> {
    return await post<any>('/api/picked/clear', data);
}

export async function api_picked_ids(data: any): Promise<string[]> {
    return await post<string[]>('/api/picked/ids', data);
}

export async function api_stats(data: any): Promise<Res.StatsResponse> {
    return await post<Res.StatsResponse>('/api/stats', data);
}

export async function api_library_find_new_files(data: any): Promise<any> {
    return await post<any>('/api/library/find-new-files', data);
}

export async function api_library_import_batch(data: any): Promise<any> {
    return await post<any>('/api/library/import-batch', data);
}

export async function api_library_generate_thumbnails(data: any): Promise<any> {
    return await post<any>('/api/library/generate-thumbnails', data);
}

export async function api_library_cancel_task(data: any): Promise<any> {
    return await post<any>('/api/library/cancel-task', data);
}

export async function api_settings_get(data: any): Promise<any> {
    return await post<any>('/api/settings/get', data);
}

export async function api_settings_set(data: any): Promise<any> {
    return await post<any>('/api/settings/set', data);
}

export async function api_export_prepare(data: any): Promise<any> {
    return await post<any>('/api/export/prepare', data);
}

