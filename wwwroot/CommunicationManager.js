import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
export async function post(url, data) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!res.ok)
        return null;
    return await res.json();
}
export class CommunicationManager {
    constructor() {
        this.ws = null;
        this.requestMap = new Map();
        this.nextRequestId = 1;
        this.isConnected = false;
        this.pendingRequests = [];
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 256000;
        this.connectWs();
    }
    connectWs() {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${window.location.host}/ws`);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onopen = () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            hub.pub('connection.changed', { connected: true, connecting: false });
            this.processPending();
        };
        this.ws.onclose = () => {
            this.isConnected = false;
            hub.pub('connection.changed', { connected: false, connecting: false });
            const delay = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, this.maxReconnectDelay);
            this.reconnectAttempts++;
            setTimeout(() => {
                hub.pub('connection.changed', { connected: false, connecting: true });
                this.connectWs();
            }, delay);
        };
        this.ws.onmessage = (e) => {
            if (typeof e.data === 'string') {
                try {
                    const msg = JSON.parse(e.data);
                    if (msg.type === 'file.imported') {
                        hub.pub('photo.imported', { id: msg.id, path: msg.path });
                    }
                    else if (msg.type === 'scan.finished') {
                        hub.pub('library.updated', {});
                    }
                    else if (msg.type === 'folder.progress') {
                        hub.pub('folder.progress', { rootId: msg.rootId, processed: msg.processed, total: msg.total });
                    }
                    else if (msg.type === 'folder.finished') {
                        hub.pub('folder.finished', { rootId: msg.rootId });
                    }
                }
                catch (err) {
                    console.error("Failed to parse WS text message", err);
                }
            }
            else {
                this.handleBinaryMessage(e.data);
            }
        };
    }
    handleBinaryMessage(buffer) {
        const view = new DataView(buffer);
        const reqId = view.getInt32(0, true);
        const data = buffer.slice(4);
        if (this.requestMap.has(reqId)) {
            this.requestMap.get(reqId)(new Blob([data], { type: 'image/jpeg' }));
            this.requestMap.delete(reqId);
        }
    }
    requestImage(fileId, size) {
        return new Promise(resolve => {
            const requestId = this.nextRequestId++;
            this.requestMap.set(requestId, resolve);
            const payload = { requestId, fileId, size };
            if (this.isConnected && this.ws) {
                this.ws.send(JSON.stringify(payload));
            }
            else {
                this.pendingRequests.push(payload);
            }
        });
    }
    processPending() {
        while (this.pendingRequests.length && this.isConnected) {
            this.ws?.send(JSON.stringify(this.pendingRequests.shift()));
        }
    }
    // --- High-Level Actions ---
    async togglePick(photo) {
        const original = photo.isPicked;
        const newStatus = !original;
        photo.isPicked = newStatus;
        hub.pub('photo.updated', { id: photo.id, photo });
        if (newStatus)
            hub.pub('ui.notification', { message: `Image ${photo.fileName} Picked`, type: 'success' });
        try {
            const ids = photo.stackFileIds || [photo.id];
            await Promise.all(ids.map(id => Api.api_pick({ id, isPicked: newStatus })));
            if (newStatus)
                hub.pub('photo.picked.added', { id: photo.id });
            else
                hub.pub('photo.picked.removed', { id: photo.id });
        }
        catch {
            photo.isPicked = original;
            hub.pub('photo.updated', { id: photo.id, photo });
            hub.pub('ui.notification', { message: 'Failed to update pick status', type: 'error' });
        }
    }
    async setRating(photo, rating) {
        const prev = photo.rating;
        if (prev === rating)
            return;
        photo.rating = rating;
        hub.pub('photo.updated', { id: photo.id, photo });
        hub.pub('ui.notification', { message: `Image ${photo.fileName} rated ${rating} stars`, type: 'success' });
        try {
            const ids = photo.stackFileIds || [photo.id];
            await Promise.all(ids.map(id => Api.api_rate({ id, rating })));
            if (prev === 0 && rating > 0)
                hub.pub('photo.starred.added', { id: photo.id, rating });
            else if (prev > 0 && rating === 0)
                hub.pub('photo.starred.removed', { id: photo.id, previousRating: prev });
            else
                hub.pub('photo.starred.changed', { id: photo.id, rating, previousRating: prev });
        }
        catch {
            photo.rating = prev;
            hub.pub('photo.updated', { id: photo.id, photo });
            hub.pub('ui.notification', { message: 'Failed to update rating', type: 'error' });
        }
    }
}
export const server = new CommunicationManager();
