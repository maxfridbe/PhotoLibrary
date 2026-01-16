import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
import { constants } from './constants.js';
import { patch } from './snabbdom-setup.js';
import { LibraryStatistics } from './components/library/LibraryStatistics.js';
import { LibraryLocations } from './components/library/LibraryLocations.js';
import { LibraryImport } from './components/library/LibraryImport.js';
const ps = constants.pubsub;
export class LibraryManager {
    constructor() {
        this.scanResults = [];
        this.infoCache = null;
        this.isIndexing = false;
        this.isScanning = false;
        this.isCancelling = false;
        this.containerId = null;
        this.layout = null;
        this.statsVNode = null;
        this.locationsVNode = null;
        this.importVNode = null;
        this.localScanResults = [];
        this.selectedLocalFiles = new Set();
        this.isLocalScanning = false;
        this.currentScanPath = '';
        this.renderPending = false;
        this.fsRoots = [];
        this.quickSelectRoots = [];
        this.locationsExpanded = new Set();
        this.fsInitialized = false;
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
        const container = document.getElementById(containerId);
        if (!container)
            return;
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
        this.layout.registerComponent('statistics', function (container) {
            const el = document.createElement('div');
            el.className = 'gl-component';
            container.getElement().append(el);
            self.statsVNode = el;
            self._renderStats();
        });
        this.layout.registerComponent('locations', function (container) {
            const el = document.createElement('div');
            el.className = 'gl-component';
            container.getElement().append(el);
            self.locationsVNode = el;
            self._renderLocations();
        });
        this.layout.registerComponent('import', function (container) {
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
        this._renderStats();
        this._renderLocations();
        this._renderImport();
    }
    _renderStats() {
        if (!this.statsVNode)
            return;
        this.statsVNode = patch(this.statsVNode, LibraryStatistics(this.infoCache));
    }
    _renderLocations() {
        if (!this.locationsVNode)
            return;
        const props = {
            roots: this.quickSelectRoots,
            expandedFolders: this.locationsExpanded,
            onPathChange: (path) => {
                console.log(`[LibraryManager] Path changed to: ${path}`);
                this.currentScanPath = path;
                this.render();
            },
            onToggle: (id) => this.toggleLocationExpanded(id),
            onFolderContextMenu: (e, id) => {
                // We'll need a reference to the main app to show the context menu
                // or just handle it here if possible. 
                // For now, let's assume we can use hub or global app reference.
                window.app.showFolderContextMenu(e, id);
            },
            onAnnotationSave: async (id, annotation, color) => {
                const node = this.quickSelectRoots.find(r => r.id === id);
                if (!node)
                    return;
                const targetColor = color || node.color;
                await Api.api_library_set_annotation({ folderId: id, annotation, color: targetColor || undefined });
                node.annotation = annotation;
                if (targetColor)
                    node.color = targetColor;
                this.render();
            },
            onCancelTask: (id) => Api.api_library_cancel_task({ id: `thumbnails-${id}` }),
            // Find & Index Props
            scanResults: this.scanResults,
            isIndexing: this.isIndexing,
            isScanning: this.isScanning,
            isCancelling: this.isCancelling,
            currentScanPath: this.currentScanPath,
            onFindNew: (path, limit) => this.findNewFiles(path, limit),
            onIndexFiles: (path, low, med) => this.triggerScan(path, low, med),
            onCancelImport: () => {
                this.isCancelling = true;
                this.render();
                Api.api_library_cancel_task({ id: 'import-batch' }).then(() => {
                    this.isCancelling = false;
                    this.render();
                });
            },
            onScanPathChange: (path) => {
                this.currentScanPath = path;
                this.render();
            }
        };
        this.locationsVNode = patch(this.locationsVNode, LibraryLocations(props));
    }
    _renderImport() {
        if (!this.importVNode)
            return;
        const props = {
            fsRoots: this.fsRoots,
            onFsToggle: (node) => this.toggleFsNode(node),
            onSelect: (path) => {
                this.currentScanPath = path;
                this.render();
            },
            currentScanPath: this.currentScanPath,
            onFindLocal: (path) => this.findLocalFiles(path),
            isScanning: this.isLocalScanning,
            scanResults: this.localScanResults,
            selectedFiles: this.selectedLocalFiles,
            onToggleFile: (path) => this.toggleLocalFileSelection(path),
            onSelectAll: () => this.selectAllLocalFiles()
        };
        this.importVNode = patch(this.importVNode, LibraryImport(props));
    }
    async loadLibraryInfo() {
        try {
            const info = await Api.api_library_info({});
            if (!info)
                return;
            this.infoCache = info;
            this.isIndexing = info.isIndexing;
            // Fetch quick select roots (registered folders)
            try {
                const roots = await Api.api_directories({});
                this.quickSelectRoots = roots || [];
                if (this.currentScanPath === '' && this.quickSelectRoots.length > 0) {
                    this.currentScanPath = this.quickSelectRoots[0].name || '';
                }
            }
            catch (e) {
                console.error("Failed to fetch directories", e);
            }
            if (this.isIndexing && this.scanResults.length === 0) {
                this.scanResults = Array(info.totalToIndex).fill(null).map((_, i) => ({
                    path: i < info.indexedCount ? 'Indexed' : '...',
                    status: i < info.indexedCount ? 'indexed' : 'pending'
                }));
            }
            this.initFileSystem();
            this.render();
        }
        catch (e) {
            console.error("Failed to load library info", e);
        }
    }
    async initFileSystem() {
        if (this.fsInitialized)
            return;
        this.fsInitialized = true;
        try {
            const res = await Api.api_fs_list({ name: "" });
            if (Array.isArray(res)) {
                this.fsRoots = res.map((d) => ({
                    path: d.path,
                    name: d.name,
                    isExpanded: false,
                    children: undefined // undefined means "has children but not loaded", null/empty means "leaf"
                }));
                this.render();
            }
        }
        catch (e) {
            console.error("Failed to init FS", e);
        }
    }
    async toggleFsNode(node) {
        node.isExpanded = !node.isExpanded;
        if (node.isExpanded && !node.children) {
            node.isLoading = true;
            this.render();
            try {
                const res = await Api.api_fs_list({ name: node.path });
                if (Array.isArray(res)) {
                    node.children = res.map((d) => ({
                        path: d.path,
                        name: d.name,
                        isExpanded: false,
                        children: undefined
                    }));
                }
                else {
                    node.children = [];
                }
            }
            catch (e) {
                console.error("Failed to list dir", e);
                node.children = []; // Error state
            }
            finally {
                node.isLoading = false;
                this.render();
            }
        }
        else {
            this.render();
        }
    }
    toggleLocationExpanded(id) {
        if (this.locationsExpanded.has(id)) {
            this.locationsExpanded.delete(id);
        }
        else {
            this.locationsExpanded.add(id);
        }
        this.render();
    }
    toggleLocalFileSelection(path) {
        if (this.selectedLocalFiles.has(path)) {
            this.selectedLocalFiles.delete(path);
        }
        else {
            this.selectedLocalFiles.add(path);
        }
        this.render();
    }
    selectAllLocalFiles() {
        if (this.selectedLocalFiles.size === this.localScanResults.length) {
            this.selectedLocalFiles.clear();
        }
        else {
            this.selectedLocalFiles = new Set(this.localScanResults);
        }
        this.render();
    }
    async findLocalFiles(path) {
        if (!path)
            return;
        this.isLocalScanning = true;
        this.selectedLocalFiles.clear();
        this.render();
        try {
            const res = await Api.api_fs_find_files({ name: path });
            if (res && res.files) {
                this.localScanResults = res.files;
            }
        }
        catch (e) {
            console.error("Failed to find local files", e);
        }
        finally {
            this.isLocalScanning = false;
            this.render();
        }
    }
    async findNewFiles(path, limit) {
        if (!path)
            return;
        try {
            this.isScanning = true;
            this.render();
            const res = await Api.api_library_find_new_files({ name: `${path}|${limit}` });
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
