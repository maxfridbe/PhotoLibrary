import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
import { post } from './CommunicationManager.js';
import { constants } from './constants.js';
import { patch } from './snabbdom-setup.js';
import { LibraryScreen } from './components/library/LibraryScreen.js';
const ps = constants.pubsub;
export class LibraryManager {
    constructor() {
        this.scanResults = [];
        this.infoCache = null;
        this.isIndexing = false;
        this.isScanning = false;
        this.libraryVNode = null;
        this.containerId = null;
        this.currentScanPath = '';
        this.renderPending = false;
        hub.sub(ps.PHOTO_IMPORTED, (data) => {
            const item = this.scanResults.find(r => data.path.endsWith(r.path));
            if (item) {
                item.status = 'indexed';
                this.render();
            }
        });
        hub.sub(ps.LIBRARY_UPDATED, () => {
            this.isIndexing = false;
            this.loadLibraryInfo();
            document.title = 'Photo Library';
        });
        hub.sub(ps.FOLDER_CREATED, () => {
            this.loadLibraryInfo();
        });
    }
    initLayout(containerId, triggerScanCallback) {
        this.containerId = containerId;
        this.loadLibraryInfo();
    }
    render() {
        if (this.renderPending)
            return;
        this.renderPending = true;
        requestAnimationFrame(() => {
            this.renderPending = false;
            this._renderNow();
        });
    }
    _renderNow() {
        if (!this.containerId)
            return;
        const el = document.getElementById(this.containerId);
        if (!el)
            return;
        const props = {
            containerId: this.containerId,
            info: this.infoCache,
            scanResults: this.scanResults,
            isIndexing: this.isIndexing,
            isScanning: this.isScanning,
            currentScanPath: this.currentScanPath,
            onFindNew: (path, limit) => this.findNewFiles(path, limit),
            onIndexFiles: (path, low, med) => this.triggerScan(path, low, med),
            onCancelImport: () => Api.api_library_cancel_task({ id: 'import-batch' }),
            onPathChange: (path) => {
                console.log(`[LibraryManager] Path changed to: ${path}`);
                this.currentScanPath = path;
                this.render();
            }
        };
        this.libraryVNode = patch(this.libraryVNode || el, LibraryScreen(props));
    }
    async loadLibraryInfo() {
        try {
            const info = await post('/api/library/info', {});
            if (!info)
                return;
            this.infoCache = info;
            this.isIndexing = info.isIndexing;
            if (this.currentScanPath === '' && info.folders.length > 0) {
                this.currentScanPath = info.folders[0].path;
            }
            if (this.isIndexing && this.scanResults.length === 0) {
                this.scanResults = Array(info.totalToIndex).fill(null).map((_, i) => ({
                    path: i < info.indexedCount ? 'Indexed' : '...',
                    status: i < info.indexedCount ? 'indexed' : 'pending'
                }));
            }
            this.render();
        }
        catch (e) {
            console.error("Failed to load library info", e);
        }
    }
    async findNewFiles(path, limit) {
        if (!path)
            return;
        try {
            this.isScanning = true;
            this.render();
            const res = await post('/api/library/find-new-files', { name: `${path}|${limit}` });
            if (res && res.files) {
                this.scanResults = res.files.map((f) => ({ path: f, status: 'pending' }));
            }
        }
        catch (e) {
            console.error('Error searching path', e);
        }
        finally {
            this.isScanning = false;
            this.render();
        }
    }
    async triggerScan(path, low, med) {
        if (!path || this.scanResults.length === 0)
            return;
        this.isIndexing = true;
        this.render();
        const res = await post('/api/library/import-batch', {
            rootPath: path,
            relativePaths: this.scanResults.map(r => r.path),
            generateLow: low,
            generateMedium: med
        });
        if (res) {
            hub.pub(ps.UI_NOTIFICATION, { message: "Batch indexing started", type: "success" });
        }
    }
}
