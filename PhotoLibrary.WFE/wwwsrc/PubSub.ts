import * as Res from './Responses.generated.js';
import { constants } from './constants.js';

const ps = constants.pubsub;

export interface EventMap {
    [ps.VIEW_MODE_CHANGED]: { mode: 'grid' | 'loupe' | 'library', id?: string };
    [ps.PHOTO_SELECTED]: { id: string, photo: Res.PhotoResponse, modifiers?: { shift: boolean, ctrl: boolean } };
    [ps.PHOTO_UPDATED]: { id: string, photo: Res.PhotoResponse };
    [ps.PHOTO_ROTATED]: { id: string, rotation: number };
    
    // Status Events
    [ps.PHOTO_PICKED_ADDED]: { id: string };
    [ps.PHOTO_PICKED_REMOVED]: { id: string };
    [ps.PHOTO_STARRED_ADDED]: { id: string, rating: number };
    [ps.PHOTO_STARRED_REMOVED]: { id: string, previousRating: number };
    [ps.PHOTO_STARRED_CHANGED]: { id: string, rating: number, previousRating: number };

    [ps.LIBRARY_REFRESH]: {};
    [ps.LIBRARY_UPDATED]: {};
    [ps.PHOTO_IMPORTED]: { id: string, path: string, rootId?: string };
    [ps.FOLDER_CREATED]: { id: string, name: string };
    [ps.FOLDER_PROGRESS]: { rootId: string, processed: number, total: number, thumbnailed?: number };
    [ps.FOLDER_FINISHED]: { rootId: string };
    [ps.PREVIEW_GENERATED]: { fileId: string, rootId: string };
    [ps.PREVIEW_GENERATING]: { fileId: string };
    [ps.PREVIEW_DELETED]: { fileId: string };
    [ps.SEARCH_TRIGGERED]: { tag?: string, value?: string, query?: string };
    [ps.SHORTCUTS_SHOW]: {};

    // UI Events
    [ps.UI_LAYOUT_CHANGED]: {}; 
    [ps.UI_NOTIFICATION]: { message: string, type: 'info' | 'error' | 'success' };
    [ps.UI_SEARCH_STATUS]: { active: boolean, message?: string };
    [ps.CONNECTION_CHANGED]: { connected: boolean, connecting: boolean };
    [ps.RUNTIME_STATS]: { memoryBytes: number, sentBytesPerSec: number, recvBytesPerSec: number };
}

type Callback<T> = (data: T) => void;

// REQ-WFE-00011
class PubSub {
    private subs: Map<string, Callback<any>[]> = new Map();

    public sub<K extends keyof EventMap>(event: K, cb: Callback<EventMap[K]>) {
        if (!this.subs.has(event)) this.subs.set(event, []);
        this.subs.get(event)!.push(cb);
    }

    public subPattern(pattern: string, cb: Callback<any>) {
        if (!this.subs.has(pattern)) this.subs.set(pattern, []);
        this.subs.get(pattern)!.push(cb);
    }

    public pub<K extends keyof EventMap>(event: K, data: EventMap[K]) {
        console.log(`[PubSub] PUB: ${event}`, data);
        this.trigger(event, data);
        for (const key of this.subs.keys()) {
            if (key.endsWith('.*')) {
                const prefix = key.slice(0, -1);
                if (event.startsWith(prefix)) {
                    this.trigger(key, { event, data });
                }
            }
        }
    }

    private trigger(key: string, data: any) {
        const eventSubs = this.subs.get(key);
        if (eventSubs) {
            eventSubs.forEach(cb => cb(data));
        }
    }
}

export const hub = new PubSub();
