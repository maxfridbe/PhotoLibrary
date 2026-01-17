import * as Res from './Responses.generated.js';
import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
import { constants } from './constants.js';
import { h, VNode, patch } from './snabbdom-setup.js';
import { LibraryStatistics } from './components/library/LibraryStatistics.js';
import { LibraryLocations } from './components/library/LibraryLocations.js';
import { LibraryImport } from './components/library/LibraryImport.js';
import { FSNode } from './components/import/FileSystemBrowser.js';
import { post } from './CommunicationManager.js';

declare var GoldenLayout: any;

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
    
    private containerId: string | null = null;
    private layout: any = null;
    
    private statsVNode: VNode | HTMLElement | null = null;
    private locationsVNode: VNode | HTMLElement | null = null;
    private importVNode: VNode | HTMLElement | null = null;

    private localScanResults: string[] = [];
    private selectedLocalFiles: Set<string> = new Set();
    private isLocalScanning = false;

    private currentScanPath: string = '';
    private renderPending = false;
    
    private fsRoots: FSNode[] = [];
    private quickSelectRoots: Res.DirectoryNodeResponse[] = [];
    private locationsExpanded: Set<string> = new Set();
    private fsInitialized = false;

    private isBackingUp = false;

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
        const container = document.getElementById(containerId);
        if (!container) return;
        
        container.innerHTML = ''; // Clear previous

        const config = {
            settings: { showPopoutIcon: false },
            content: [{
                type: 'row',
                content: [
                    { type: 'component', componentName: 'statistics', title: 'Statistics', width: 30 },
                    { 
                        type: 'stack', 
                        width: 70,
                        content: [
                            { type: 'component', componentName: 'locations', title: 'Index Locations' },
                            { type: 'component', componentName: 'import', title: 'Import and Index' }
                        ]
                    }
                ]
            }]
        };

        this.layout = new GoldenLayout(config, container);
        const self = this;

        this.layout.registerComponent('statistics', function(container: any) {
            const el = document.createElement('div');
            el.className = 'gl-component';
            container.getElement().append(el);
            self.statsVNode = el;
            self._renderStats();
        });

        this.layout.registerComponent('locations', function(container: any) {
            const el = document.createElement('div');
            el.className = 'gl-component';
            container.getElement().append(el);
            self.locationsVNode = el;
            self._renderLocations();
        });

        this.layout.registerComponent('import', function(container: any) {
            const el = document.createElement('div');
            el.className = 'gl-component';
            container.getElement().append(el);
            self.importVNode = el;
            self._renderImport();
        });

        this.layout.init();
        window.addEventListener('resize', () => { 
            this.layout.updateSize(); 
        });

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
        this._renderStats();
        this._renderLocations();
        this._renderImport();
    }

    private _renderStats() {
        if (!this.statsVNode) return;
        this.statsVNode = patch(this.statsVNode, LibraryStatistics(
            this.infoCache, 
            this.isBackingUp,
            async () => {
                if (this.isBackingUp) return;
                this.isBackingUp = true;
                this.render();
                
                try {
                    const res = await post('/api/library/backup', {});
                    if (res && res.success) {
                        hub.pub(constants.pubsub.UI_NOTIFICATION, { message: `Backup created at ${res.path}`, type: 'success' });
                        await this.loadLibraryInfo();
                    } else {
                        hub.pub(constants.pubsub.UI_NOTIFICATION, { message: `Backup failed: ${res?.error || 'Unknown error'}`, type: 'error' });
                    }
                } catch (e) {
                    hub.pub(constants.pubsub.UI_NOTIFICATION, { message: 'Backup request failed', type: 'error' });
                } finally {
                    this.isBackingUp = false;
                    this.render();
                }
            }
        ));
    }

    private _renderLocations() {
        if (!this.locationsVNode) return;
        
        const props = {
            roots: this.quickSelectRoots,
            expandedFolders: this.locationsExpanded,
            onPathChange: (path: string) => {
                console.log(`[LibraryManager] Path changed to: ${path}`);
                this.currentScanPath = path;
                this.render();
            },
            onToggle: (id: string) => this.toggleLocationExpanded(id),
            onFolderContextMenu: (e: MouseEvent, id: string) => {
                // We'll need a reference to the main app to show the context menu
                // or just handle it here if possible. 
                // For now, let's assume we can use hub or global app reference.
                (window as any).app.showFolderContextMenu(e, id);
            },
            onAnnotationSave: async (id: string, annotation: string, color?: string) => {
                const node = this.quickSelectRoots.find(r => r.id === id);
                if (!node) return;
                const targetColor = color || node.color;
                await Api.api_library_set_annotation({ folderId: id, annotation, color: targetColor || undefined });
                node.annotation = annotation;
                if (targetColor) node.color = targetColor;
                this.render();
            },
            onCancelTask: (id: string) => Api.api_library_cancel_task({ id: `thumbnails-${id}` }),
            
            // Find & Index Props
            scanResults: this.scanResults,
            isIndexing: this.isIndexing,
            isScanning: this.isScanning,
            isCancelling: this.isCancelling,
            currentScanPath: this.currentScanPath,
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
            onScanPathChange: (path: string) => {
                this.currentScanPath = path;
                this.render();
            }
        };

        this.locationsVNode = patch(this.locationsVNode, LibraryLocations(props));
    }

    private _renderImport() {
        if (!this.importVNode) return;
        
        const props = {
            fsRoots: this.fsRoots,
            onFsToggle: (node: FSNode) => this.toggleFsNode(node),
            onSelect: (path: string) => {
                this.currentScanPath = path;
                this.render();
            },
            currentScanPath: this.currentScanPath,
            onFindLocal: (path: string) => this.findLocalFiles(path),
            isScanning: this.isLocalScanning,
            scanResults: this.localScanResults,
            selectedFiles: this.selectedLocalFiles,
            onToggleFile: (path: string) => this.toggleLocalFileSelection(path),
            onSelectAll: () => this.selectAllLocalFiles()
        };

        this.importVNode = patch(this.importVNode, LibraryImport(props));
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

    private toggleLocationExpanded(id: string) {
        if (this.locationsExpanded.has(id)) {
            this.locationsExpanded.delete(id);
        } else {
            this.locationsExpanded.add(id);
        }
        this.render();
    }

    private toggleLocalFileSelection(path: string) {
        if (this.selectedLocalFiles.has(path)) {
            this.selectedLocalFiles.delete(path);
        } else {
            this.selectedLocalFiles.add(path);
        }
        this.render();
    }

    private selectAllLocalFiles() {
        if (this.selectedLocalFiles.size === this.localScanResults.length) {
            this.selectedLocalFiles.clear();
        } else {
            this.selectedLocalFiles = new Set(this.localScanResults);
        }
        this.render();
    }

    private async findLocalFiles(path: string) {
        if (!path) return;
        this.isLocalScanning = true;
        this.selectedLocalFiles.clear();
        this.render();
        try {
            const res = await Api.api_fs_find_files({ name: path });
            if (res && res.files) {
                this.localScanResults = res.files;
            }
        } catch (e) {
            console.error("Failed to find local files", e);
        } finally {
            this.isLocalScanning = false;
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