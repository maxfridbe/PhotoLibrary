import { constants } from './constants.js';
const ps = constants.pubsub;
// REQ-WFE-00011
class PubSub {
    constructor() {
        this.subs = new Map();
    }
    sub(event, cb) {
        if (!this.subs.has(event))
            this.subs.set(event, []);
        this.subs.get(event).push(cb);
    }
    subPattern(pattern, cb) {
        if (!this.subs.has(pattern))
            this.subs.set(pattern, []);
        this.subs.get(pattern).push(cb);
    }
    pub(event, data) {
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
    trigger(key, data) {
        const eventSubs = this.subs.get(key);
        if (eventSubs) {
            eventSubs.forEach(cb => cb(data));
        }
    }
}
export const hub = new PubSub();
