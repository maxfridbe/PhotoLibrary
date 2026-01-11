import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';
import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';

class ServerOperations {
    private ws: WebSocket | null = null;
    private requestMap: Map<number, (blob: Blob) => void> = new Map();
    private nextRequestId = 1;
    private isConnected = false;
    private pendingRequests: Req.ImageRequest[] = [];
    private reconnectAttempts = 0;
    private readonly maxReconnectDelay = 256000;

    constructor() {
        this.connectWs();
    }

    private connectWs() {
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

        this.ws.onmessage = (e) => this.handleBinaryMessage(e.data);
    }

    private handleBinaryMessage(buffer: ArrayBuffer) {
        const view = new DataView(buffer);
        const reqId = view.getInt32(0, true);
        const data = buffer.slice(4);
        if (this.requestMap.has(reqId)) {
            this.requestMap.get(reqId)!(new Blob([data], { type: 'image/jpeg' }));
            this.requestMap.delete(reqId);
        }
    }

    public requestImage(fileId: string, size: number): Promise<Blob> {
        return new Promise(resolve => {
            const requestId = this.nextRequestId++;
            this.requestMap.set(requestId, resolve);
            const payload: Req.ImageRequest = { requestId, fileId, size };
            if (this.isConnected && this.ws) {
                this.ws.send(JSON.stringify(payload));
            } else {
                this.pendingRequests.push(payload);
            }
        });
    }

    private processPending() {
        while (this.pendingRequests.length && this.isConnected) {
            this.ws?.send(JSON.stringify(this.pendingRequests.shift()));
        }
    }

    // --- High-Level Actions ---

    async togglePick(photo: Res.PhotoResponse) {
        const original = photo.isPicked;
        const newStatus = !original;
        photo.isPicked = newStatus;
        
        // 1. Instant local visual update (card flag)
        hub.pub('photo.updated', { id: photo.id, photo });

        try {
            // 2. Wait for server confirmation
            await Api.api_pick({ id: photo.id, isPicked: newStatus });
            
            // 3. Trigger global stats refresh ONLY after DB is updated
            if (newStatus) hub.pub('photo.picked.added', { id: photo.id });
            else hub.pub('photo.picked.removed', { id: photo.id });
        } catch {
            photo.isPicked = original; // Revert
            hub.pub('photo.updated', { id: photo.id, photo });
            hub.pub('ui.notification', { message: 'Failed to update pick status', type: 'error' });
        }
    }

    async setRating(photo: Res.PhotoResponse, rating: number) {
        const prev = photo.rating;
        if (prev === rating) return;

        // 1. Instant local visual update (card stars)
        photo.rating = rating;
        hub.pub('photo.updated', { id: photo.id, photo });

        try {
            // 2. Wait for server confirmation
            await Api.api_rate({ id: photo.id, rating: rating });

            // 3. Trigger global stats refresh ONLY after DB is updated
            if (prev === 0 && rating > 0) hub.pub('photo.starred.added', { id: photo.id, rating });
            else if (prev > 0 && rating === 0) hub.pub('photo.starred.removed', { id: photo.id, previousRating: prev });
            else hub.pub('photo.starred.changed', { id: photo.id, rating, previousRating: prev });
        } catch {
            photo.rating = prev; // Revert
            hub.pub('photo.updated', { id: photo.id, photo });
            hub.pub('ui.notification', { message: 'Failed to update rating', type: 'error' });
        }
    }
}

export const server = new ServerOperations();