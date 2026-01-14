import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
import { constants } from './constants.js';
const ps = constants.pubsub;
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
        this.imageQueue = [];
        this.inFlightRequests = 0;
        this.maxInFlight = 12;
        this.lastResponseTime = 500;
        this.lastSendTime = 0;
        this.requestSendTimes = new Map();
        this.processTimer = null;
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
            hub.pub(ps.CONNECTION_CHANGED, { connected: true, connecting: false });
            this.processQueue();
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
                    if (msg.type === 'file.imported') {
                        hub.pub(ps.PHOTO_IMPORTED, { id: msg.id, path: msg.path, rootId: msg.rootId });
                    }
                    else if (msg.type === 'folder.created') {
                        hub.pub(ps.FOLDER_CREATED, { id: msg.id, name: msg.name });
                    }
                    else if (msg.type === 'scan.finished') {
                        hub.pub(ps.LIBRARY_UPDATED, {});
                    }
                    else if (msg.type === 'folder.progress') {
                        hub.pub(ps.FOLDER_PROGRESS, { rootId: msg.rootId, processed: msg.processed, total: msg.total, thumbnailed: msg.thumbnailed });
                    }
                    else if (msg.type === 'folder.finished') {
                        hub.pub(ps.FOLDER_FINISHED, { rootId: msg.rootId });
                    }
                    else if (msg.type === 'preview.generated') {
                        hub.pub(ps.PREVIEW_GENERATED, { fileId: msg.fileId, rootId: msg.rootId });
                    }
                    else if (msg.type === 'preview.generating') {
                        hub.pub(ps.PREVIEW_GENERATING, { fileId: msg.fileId });
                    }
                    else if (msg.type === 'preview.deleted') {
                        hub.pub(ps.PREVIEW_DELETED, { fileId: msg.fileId });
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
            const sendTime = this.requestSendTimes.get(reqId);
            if (sendTime) {
                const duration = Date.now() - sendTime;
                // Weight new measurements more heavily if they are slow
                const weight = duration > this.lastResponseTime ? 0.4 : 0.1;
                this.lastResponseTime = this.lastResponseTime * (1 - weight) + duration * weight;
                this.requestSendTimes.delete(reqId);
            }
            this.inFlightRequests--;
            const resolve = this.requestMap.get(reqId);
            this.requestMap.delete(reqId);
            resolve(new Blob([data], { type: 'image/jpeg' }));
            // Re-process queue immediately when a slot opens
            this.processQueue();
        }
        else {
            console.warn(`[WS] Received response for unknown/stale requestId: ${reqId}`);
        }
    }
    requestImage(fileId, size, priority = 0) {
        return new Promise((resolve) => {
            const requestId = this.nextRequestId++;
            const req = { type: 'image', requestId, fileId, size };
            // Boost priority for high-res/fullscreen requests
            let p = priority;
            if (size === 0)
                p += 100000;
            else if (size === 1024)
                p += 10000;
            this.imageQueue.push({ req, resolve, priority: p, index: requestId });
            // If we are significantly under capacity, process immediately
            if (this.inFlightRequests < Math.floor(this.maxInFlight / 2)) {
                this.processQueue();
            }
            else if (!this.processTimer) {
                this.processQueue();
            }
        });
    }
    processQueue() {
        if (!this.isConnected || this.ws?.readyState !== WebSocket.OPEN)
            return;
        // Sorting is expensive, only do it if we have something to potentially send
        if (this.imageQueue.length > 0 && this.inFlightRequests < this.maxInFlight) {
            this.imageQueue.sort((a, b) => {
                if (b.priority !== a.priority)
                    return b.priority - a.priority;
                return a.index - b.index;
            });
            if (this.imageQueue.length > 0) {
                console.log(`[QUEUE] In-flight: ${this.inFlightRequests}/${this.maxInFlight}, Queue: ${this.imageQueue.length}, Delay: ${Math.round(this.lastResponseTime)}ms. Next: ${this.imageQueue[0].req.fileId} (s:${this.imageQueue[0].req.size})`);
            }
        }
        const now = Date.now();
        const timeSinceLast = now - this.lastSendTime;
        const targetDelay = Math.max(50, Math.min(5000, this.lastResponseTime));
        if (this.inFlightRequests < this.maxInFlight && this.imageQueue.length > 0) {
            if (timeSinceLast >= targetDelay) {
                if (this.processTimer)
                    clearTimeout(this.processTimer);
                this.processTimer = null;
                // Send a batch
                let sentInBatch = 0;
                const batchSize = this.lastResponseTime < 200 ? 6 : 3;
                while (sentInBatch < batchSize && this.inFlightRequests < this.maxInFlight && this.imageQueue.length > 0) {
                    const item = this.imageQueue.shift();
                    this.inFlightRequests++;
                    this.lastSendTime = Date.now();
                    this.requestSendTimes.set(item.req.requestId, this.lastSendTime);
                    this.requestMap.set(item.req.requestId, item.resolve);
                    this.ws.send(JSON.stringify(item.req));
                    sentInBatch++;
                }
                // Schedule next batch
                if (this.imageQueue.length > 0) {
                    this.processTimer = setTimeout(() => {
                        this.processTimer = null;
                        this.processQueue();
                    }, targetDelay);
                }
            }
            else if (!this.processTimer) {
                // Schedule check for when the delay expires
                this.processTimer = setTimeout(() => {
                    this.processTimer = null;
                    this.processQueue();
                }, targetDelay - timeSinceLast);
            }
        }
    }
    // --- High-Level Actions ---
    async togglePick(photo) {
        const original = photo.isPicked;
        const newStatus = !original;
        photo.isPicked = newStatus;
        hub.pub(ps.PHOTO_UPDATED, { id: photo.id, photo });
        if (newStatus)
            hub.pub(ps.UI_NOTIFICATION, { message: `Image ${photo.fileName} Picked`, type: 'success' });
        try {
            const ids = photo.stackFileIds || [photo.id];
            await Promise.all(ids.map(id => Api.api_pick({ id, isPicked: newStatus })));
            if (newStatus)
                hub.pub(ps.PHOTO_PICKED_ADDED, { id: photo.id });
            else
                hub.pub(ps.PHOTO_PICKED_REMOVED, { id: photo.id });
        }
        catch {
            photo.isPicked = original;
            hub.pub(ps.PHOTO_UPDATED, { id: photo.id, photo });
            hub.pub(ps.UI_NOTIFICATION, { message: 'Failed to update pick status', type: 'error' });
        }
    }
    async setRating(photo, rating) {
        const prev = photo.rating;
        if (prev === rating)
            return;
        photo.rating = rating;
        hub.pub(ps.PHOTO_UPDATED, { id: photo.id, photo });
        hub.pub(ps.UI_NOTIFICATION, { message: `Image ${photo.fileName} rated ${rating} stars`, type: 'success' });
        try {
            const ids = photo.stackFileIds || [photo.id];
            await Promise.all(ids.map(id => Api.api_rate({ id, rating })));
            if (prev === 0 && rating > 0)
                hub.pub(ps.PHOTO_STARRED_ADDED, { id: photo.id, rating });
            else if (prev > 0 && rating === 0)
                hub.pub(ps.PHOTO_STARRED_REMOVED, { id: photo.id, previousRating: prev });
            else
                hub.pub(ps.PHOTO_STARRED_CHANGED, { id: photo.id, rating, previousRating: prev });
        }
        catch {
            photo.rating = prev;
            hub.pub(ps.PHOTO_UPDATED, { id: photo.id, photo });
            hub.pub(ps.UI_NOTIFICATION, { message: 'Failed to update rating', type: 'error' });
        }
    }
}
export const server = new CommunicationManager();
