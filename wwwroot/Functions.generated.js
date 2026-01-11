async function post(url, data = {}) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return await res.json();
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
