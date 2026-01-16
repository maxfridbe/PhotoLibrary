import * as Res from './Responses.generated.js';
import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
import { constants } from './constants.js';
import { h, VNode, patch } from './snabbdom-setup.js';
import { LibraryScreen } from './components/library/LibraryScreen.js';
import { FSNode } from './components/import/FileSystemBrowser.js';

const ps = constants.pubsub;

interface ScanResultItem {
    path: string;
    status: 'pending' | 'indexed';
}

export class LibraryManager {
    private scanResults: ScanResultItem[] = [];
    private infoCache: Res.LibraryInfoResponse | null = null;
    private isIndexing = false;
    private isScanning = false;
    private isCancelling = false;
    private libraryVNode: VNode | HTMLElement | null = null;
    private containerId: string | null = null;
    private currentScanPath: string = '';
    private renderPending = false;
    
    private fsRoots: FSNode[] = [];
    private quickSelectRoots: Res.DirectoryNodeResponse[] = [];
    private fsInitialized = false;

    constructor() {
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

    public initLayout(containerId: string, triggerScanCallback: () => void) {
        this.containerId = containerId;
        this.loadLibraryInfo();
    }

    private render() {
        if (this.renderPending) return;
        this.renderPending = true;
        requestAnimationFrame(() => {
            this.renderPending = false;
            this._renderNow();
        });
    }

    private _renderNow() {
        if (!this.containerId) return;
        const $el = document.getElementById(this.containerId);
        if (!$el) return;

        const props = {
            containerId: this.containerId,
            info: this.infoCache,
            scanResults: this.scanResults,
            isIndexing: this.isIndexing,
            isScanning: this.isScanning,
            isCancelling: this.isCancelling,
            currentScanPath: this.currentScanPath,
            fsRoots: this.fsRoots,
            quickSelectRoots: this.quickSelectRoots,
            onFsToggle: (node: FSNode) => this.toggleFsNode(node),
            onFindNew: (path: string, limit: number) => this.findNewFiles(path, limit),
            onIndexFiles: (path: string, low: boolean, med: boolean) => this.triggerScan(path, low, med),
            onCancelImport: () => {
                this.isCancelling = true;
                this.render();
                Api.api_library_cancel_task({ id: 'import-batch' }).then(() => {
                    this.isCancelling = false;
                    this.render();
                });
            },
            onPathChange: (path: string) => {
                console.log(`[LibraryManager] Path changed to: ${path}`);
                this.currentScanPath = path;
                this.render();
            }
        };

        this.libraryVNode = patch(this.libraryVNode || $el, LibraryScreen(props));
    }

    public async loadLibraryInfo() {
        try {
            const info = await Api.api_library_info({});
            if (!info) return;
            this.infoCache = info;
            this.isIndexing = info.isIndexing;

            // Fetch quick select roots (registered folders)
            try {
                const roots = await Api.api_directories({});
                this.quickSelectRoots = roots || [];
                if (this.currentScanPath === '' && this.quickSelectRoots.length > 0) {
                    this.currentScanPath = this.quickSelectRoots[0].name || '';
                }
            } catch (e) { console.error("Failed to fetch directories", e); }

            if (this.isIndexing && this.scanResults.length === 0) {
                this.scanResults = Array(info.totalToIndex).fill(null).map((_, i) => ({
                    path: i < info.indexedCount ? 'Indexed' : '...',
                    status: i < info.indexedCount ? 'indexed' as const : 'pending' as const
                }));
            }

            this.initFileSystem();
            this.render();
        } catch (e) { console.error("Failed to load library info", e); }
    }

    private async initFileSystem() {
        if (this.fsInitialized) return;
        this.fsInitialized = true;
        try {
            const res = await Api.api_fs_list({ name: "" });
            if (Array.isArray(res)) {
                this.fsRoots = res.map((d: any) => ({
                    path: d.path,
                    name: d.name,
                    isExpanded: false,
                    children: undefined // undefined means "has children but not loaded", null/empty means "leaf"
                }));
                this.render();
            }
        } catch (e) { console.error("Failed to init FS", e); }
    }

    private async toggleFsNode(node: FSNode) {
        node.isExpanded = !node.isExpanded;
        if (node.isExpanded && !node.children) {
            node.isLoading = true;
            this.render();
            try {
                const res = await Api.api_fs_list({ name: node.path });
                if (Array.isArray(res)) {
                    node.children = res.map((d: any) => ({
                        path: d.path,
                        name: d.name,
                        isExpanded: false,
                        children: undefined
                    }));
                } else {
                    node.children = [];
                }
            } catch (e) {
                console.error("Failed to list dir", e);
                node.children = []; // Error state
            } finally {
                node.isLoading = false;
                this.render();
            }
        } else {
            this.render();
        }
    }

    private async findNewFiles(path: string, limit: number) {
        if (!path) return;
        
        try {
            this.isScanning = true;
            this.render();

            const res = await Api.api_library_find_new_files({ name: `${path}|${limit}` });
            if (res && res.files) {
                this.scanResults = res.files.map((f: string) => ({ path: f, status: 'pending' as const }));
            }
        } catch (e) {
            console.error('Error searching path', e);
        } finally {
            this.isScanning = false;
            this.render();
        }
    }

    private async triggerScan(path: string, low: boolean, med: boolean) {
        if (!path || this.scanResults.length === 0) return;

        this.isIndexing = true;
        this.render();

        const res = await Api.api_library_import_batch({ 
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