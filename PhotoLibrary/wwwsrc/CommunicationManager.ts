import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';
import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
import { constants } from './constants.js';

const ps = constants.pubsub;
const sk = constants.socket;

export async function post(url: string, data: any): Promise<any> {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) return null;
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    } catch (e) {
        console.error(`POST ${url} failed`, e);
        return null;
    }
}

interface QueuedImage {
    req: Req.ImageRequest;
    resolve: (blob: Blob) => void;
    priority: number;
    index: number;
}

// REQ-ARCH-00001
export class CommunicationManager {
    private ws: WebSocket | null = null;
    private clientId = Math.random().toString(36).substring(2, 15);
    private requestMap: Map<number, (blob: Blob) => void> = new Map();
    private pendingRequests: Map<string, { promise: Promise<Blob>, priority: number, requestId: number }> = new Map();
    private nextRequestId = 1;
    public isConnected = false;
    private reconnectAttempts = 0;
    private readonly maxReconnectDelay = 256000;

    constructor() {
        this.connectWs();
    }

    // REQ-SVC-00003
    // REQ-ARCH-00010
    private connectWs() {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${window.location.host}/ws?clientId=${this.clientId}`);
        this.ws.binaryType = 'arraybuffer';
        
        this.ws.onopen = () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            hub.pub(ps.CONNECTION_CHANGED, { connected: true, connecting: false });
        };

        this.ws.onclose = () => {
            this.isConnected = false;
            hub.pub(ps.CONNECTION_CHANGED, { connected: false, connecting: false });
            const delay = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, this.maxReconnectDelay);
            this.reconnectAttempts++;
            setTimeout(() => {
                hub.pub(ps.CONNECTION_CHANGED, { connected: false, connecting: true });
                this.connectWs();
            }, delay);
        };

        this.ws.onmessage = (e) => {
            if (typeof e.data === 'string') {
                try {
                    const msg = JSON.parse(e.data);
                    if (msg.type === sk.FILE_IMPORTED) {
                        hub.pub(ps.PHOTO_IMPORTED, { id: msg.id, path: msg.path, rootId: msg.rootId });
                    } else if (msg.type === sk.FOLDER_CREATED) {
                        hub.pub(ps.FOLDER_CREATED, { id: msg.id, name: msg.name });
                    } else if (msg.type === sk.SCAN_FINISHED) {
                        hub.pub(ps.LIBRARY_UPDATED, {});
                    } else if (msg.type === sk.FOLDER_PROGRESS) {
                        hub.pub(ps.FOLDER_PROGRESS, { rootId: msg.rootId, processed: msg.processed, total: msg.total, thumbnailed: msg.thumbnailed });
                    } else if (msg.type === sk.FOLDER_FINISHED) {
                        hub.pub(ps.FOLDER_FINISHED, { rootId: msg.rootId });
                    } else if (msg.type === sk.PREVIEW_GENERATED) {
                        hub.pub(ps.PREVIEW_GENERATED, { fileId: msg.fileId, rootId: msg.rootId });
                    } else if (msg.type === sk.PREVIEW_GENERATING) {
                        hub.pub(ps.PREVIEW_GENERATING, { fileId: msg.fileId });
                    } else if (msg.type === sk.PREVIEW_DELETED) {
                        hub.pub(ps.PREVIEW_DELETED, { fileId: msg.fileId });
                    } else if (msg.type === 'runtime.stats') {
                        hub.pub(ps.RUNTIME_STATS, msg);
                    }
                } catch (err) { console.error("Failed to parse WS text message", err); }
            } else {
                this.handleBinaryMessage(e.data);
            }
        };
    }

    private handleBinaryMessage(buffer: ArrayBuffer) {
        const view = new DataView(buffer);
        const reqId = view.getInt32(0, true);
        const data = buffer.slice(4);
        
        if (this.requestMap.has(reqId)) {
            const resolve = this.requestMap.get(reqId)!;
            this.requestMap.delete(reqId);
            resolve(new Blob([data], { type: 'image/webp' }));
        } else {
            console.warn(`[WS] Received response for unknown/stale requestId: ${reqId}`);
        }
    }

    // REQ-SVC-00003
    // REQ-ARCH-00010
    requestImage(fileId: string, size: number, priority: number = 0): Promise<Blob> {
        const cacheKey = `${fileId}-${size}`;
        
        // Boost priority for high-res/fullscreen requests
        let p = priority;
        if (size === 0) p += 100000;
        else if (size === 1024) p += 10000;

        const pending = this.pendingRequests.get(cacheKey);
        if (pending) {
            if (p > pending.priority) {
                // PROMOTE: Priority increased, send another message with the SAME requestId
                // The server will enqueue it again, and the higher priority one will process first.
                pending.priority = p;
                if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const req = { type: sk.IMAGE, requestId: pending.requestId, fileId, size, priority: p };
                    this.ws.send(JSON.stringify(req));
                }
            }
            return pending.promise;
        }

        const start = Date.now();
        const requestId = this.nextRequestId++;
        const promise = new Promise<Blob>((resolve) => {
            if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
                // If not connected, return a default/empty blob?
                // For now just finish immediately to avoid blocking.
                resolve(new Blob([], { type: 'image/webp' }));
                return;
            }

            const req = { type: sk.IMAGE, requestId, fileId, size, priority: p };
            
            this.requestMap.set(requestId, (blob) => {
                this.pendingRequests.delete(cacheKey);
                const elapsed = Date.now() - start;
                // console.log(`requested ${fileId} took ${elapsed}ms for resp`);
                resolve(blob);
            });
            
            this.ws.send(JSON.stringify(req));
        });

        this.pendingRequests.set(cacheKey, { promise, priority: p, requestId });
        return promise;
    }

    // --- High-Level Actions ---

    // REQ-WFE-00006
    async togglePick(photo: Res.PhotoResponse) {
        const original = photo.isPicked;
        const newStatus = !original;
        photo.isPicked = newStatus;
        
        hub.pub(ps.PHOTO_UPDATED, { id: photo.id, photo });
        if (newStatus) hub.pub(ps.UI_NOTIFICATION, { message: `Image ${photo.fileName} Picked`, type: 'success' });

        try {
            const ids = photo.stackFileIds || [photo.id];
            await Promise.all(ids.map(id => Api.api_pick({ id, isPicked: newStatus })));
            
            if (newStatus) hub.pub(ps.PHOTO_PICKED_ADDED, { id: photo.id });
            else hub.pub(ps.PHOTO_PICKED_REMOVED, { id: photo.id });
        } catch {
            photo.isPicked = original;
            hub.pub(ps.PHOTO_UPDATED, { id: photo.id, photo });
            hub.pub(ps.UI_NOTIFICATION, { message: 'Failed to update pick status', type: 'error' });
        }
    }

    // REQ-WFE-00006
    async setRating(photo: Res.PhotoResponse, rating: number) {
        const prev = photo.rating;
        if (prev === rating) return;

        photo.rating = rating;
        hub.pub(ps.PHOTO_UPDATED, { id: photo.id, photo });
        hub.pub(ps.UI_NOTIFICATION, { message: `Image ${photo.fileName} rated ${rating} stars`, type: 'success' });

        try {
            const ids = photo.stackFileIds || [photo.id];
            await Promise.all(ids.map(id => Api.api_rate({ id, rating })));

            if (prev === 0 && rating > 0) hub.pub(ps.PHOTO_STARRED_ADDED, { id: photo.id, rating });
            else if (prev > 0 && rating === 0) hub.pub(ps.PHOTO_STARRED_REMOVED, { id: photo.id, previousRating: prev });
            else hub.pub(ps.PHOTO_STARRED_CHANGED, { id: photo.id, rating, previousRating: prev });
        } catch {
            photo.rating = prev;
            hub.pub(ps.PHOTO_UPDATED, { id: photo.id, photo });
            hub.pub(ps.UI_NOTIFICATION, { message: 'Failed to update rating', type: 'error' });
        }
    }
}

export const server = new CommunicationManager();