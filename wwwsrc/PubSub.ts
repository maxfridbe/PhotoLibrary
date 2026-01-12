import * as Res from './Responses.generated.js';

export interface EventMap {
    'view.mode.changed': { mode: 'grid' | 'loupe' | 'library', id?: string };
    'photo.selected': { id: string, photo: Res.PhotoResponse };
    'photo.updated': { id: string, photo: Res.PhotoResponse };
    'photo.rotated': { id: string, rotation: number };
    
    // Status Events
    'photo.picked.added': { id: string };
    'photo.picked.removed': { id: string };
    'photo.starred.added': { id: string, rating: number };
    'photo.starred.removed': { id: string, previousRating: number };
    'photo.starred.changed': { id: string, rating: number, previousRating: number };

    'library.refresh': {};
    'library.updated': {};
    'photo.imported': { id: string, path: string, rootId?: string };
    'folder.progress': { rootId: string, processed: number, total: number };
    'folder.finished': { rootId: string };
    'preview.generated': { fileId: string, rootId: string };
    'search.triggered': { tag: string, value: string };
    'shortcuts.show': {};

    // UI Events
    'ui.layout.changed': {}; 
    'ui.notification': { message: string, type: 'info' | 'error' | 'success' };
    'connection.changed': { connected: boolean, connecting: boolean };
}

type Callback<T> = (data: T) => void;

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
