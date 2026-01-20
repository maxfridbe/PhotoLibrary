async function post(url, data = {}) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!res.ok)
        throw new Error(`API Error: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
}
export async function api_photos(data) {
    return await post('/api/photos', data);
}
export async function api_metadata(data) {
    return await post('/api/metadata', data);
}
export async function api_directories(data) {
    return await post('/api/directories', data);
}
export async function api_library_info(data) {
    return await post('/api/library/info', data);
}
export async function api_library_backup(data) {
    return await post('/api/library/backup', data);
}
export async function api_pick(data) {
    return await post('/api/pick', data);
}
export async function api_rate(data) {
    return await post('/api/rate', data);
}
export async function api_search(data) {
    return await post('/api/search', data);
}
export async function api_collections_list(data) {
    return await post('/api/collections/list', data);
}
export async function api_collections_create(data) {
    return await post('/api/collections/create', data);
}
export async function api_collections_delete(data) {
    return await post('/api/collections/delete', data);
}
export async function api_collections_add_files(data) {
    return await post('/api/collections/add-files', data);
}
export async function api_collections_get_files(data) {
    return await post('/api/collections/get-files', data);
}
export async function api_picked_clear(data) {
    return await post('/api/picked/clear', data);
}
export async function api_picked_ids(data) {
    return await post('/api/picked/ids', data);
}
export async function api_stats(data) {
    return await post('/api/stats', data);
}
export async function api_fs_list(data) {
    return await post('/api/fs/list', data);
}
export async function api_fs_find_files(data) {
    return await post('/api/fs/find-files', data);
}
export async function api_library_find_new_files(data) {
    return await post('/api/library/find-new-files', data);
}
export async function api_library_import_batch(data) {
    return await post('/api/library/import-batch', data);
}
export async function api_library_generate_thumbnails(data) {
    return await post('/api/library/generate-thumbnails', data);
}
export async function api_library_set_annotation(data) {
    return await post('/api/library/set-annotation', data);
}
export async function api_library_force_update_preview(data) {
    return await post('/api/library/force-update-preview', data);
}
export async function api_library_cancel_task(data) {
    return await post('/api/library/cancel-task', data);
}
export async function api_settings_get(data) {
    return await post('/api/settings/get', data);
}
export async function api_settings_set(data) {
    return await post('/api/settings/set', data);
}
export async function api_export_prepare(data) {
    return await post('/api/export/prepare', data);
}
