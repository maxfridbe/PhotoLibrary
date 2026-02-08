/** @jsx jsx */
import * as Res from './Responses.generated.js';
import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
import { constants } from './constants.js';
import { h, jsx, VNode, patch } from './snabbdom-setup.js';
import { LibraryStatistics } from './components/library/LibraryStatistics.js';
import { LibraryLocations } from './components/library/LibraryLocations.js';
import { LibraryImport } from './components/library/LibraryImport.js';
import { ImportStatusTab, ImportStatus } from './components/import/ImportStatusTab.js';
import { FSNode } from './components/import/FileSystemBrowser.js';
import { post } from './CommunicationManager.js';
import { GoldenLayout } from './lib/golden-layout.esm.js';

// declare var GoldenLayout: any;

const ps = constants.pubsub;

interface ScanResultItem {
    path: string;
    status: 'pending' | 'indexed';
    duration?: number;
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
    private importStatusVNode: VNode | HTMLElement | null = null;

    private localScanResults: Res.ScanFileResult[] = [];
    private selectedLocalFiles: Set<string> = new Set();
    private existingFiles: Set<string> = new Set();
    private isLocalScanning = false;
    private isLocalImporting = false;
    private isValidating = false;
    
    private importSessions: Map<string, {
        list: string[];
        progress: Map<string, ImportStatus>;
        friendlyName: string;
        vnode?: VNode | HTMLElement;
    }> = new Map();

    private importSettings: {
        generatePreview: boolean;
        preventDuplicateName: boolean;
        preventDuplicateHash: boolean;
        directoryTemplate: string;
        useDirectoryTemplate: boolean;
        targetRootId: string;
    } = {
        generatePreview: true,
        preventDuplicateName: true,
        preventDuplicateHash: true,
        directoryTemplate: '{YYYY}/{YYYY}-{MM}-{DD}',
        useDirectoryTemplate: true,
        targetRootId: ''
    };

    private currentScanPath: string = '';
    private renderPending = false;
    
    private fsRoots: FSNode[] = [];
    private quickSelectRoots: Res.DirectoryNodeResponse[] = [];
    private locationsExpanded: Set<string> = new Set();
    private importLocationsExpanded: Set<string> = new Set();
    private fsInitialized = false;

    private isBackingUp = false;
    private lastImportTime = 0;
    private lastItemDuration = 0;
    private importDurations: number[] = [];
    private averageDuration = 0;
    private readonly MAX_N = 100;

    constructor() {
        try {
            const savedPath = localStorage.getItem('import-source-path');
            if (savedPath) this.currentScanPath = savedPath;
            
            const savedSettings = localStorage.getItem('import-settings');
            if (savedSettings) {
                const parsed = JSON.parse(savedSettings);
                this.importSettings = { ...this.importSettings, ...parsed };
                // Ensure new property exists if loading old settings
                if (this.importSettings.useDirectoryTemplate === undefined) {
                    this.importSettings.useDirectoryTemplate = true;
                }
            }
        } catch (e) { }

        hub.sub(ps.PHOTO_IMPORTED, (data) => {
            const now = Date.now();
            if (this.lastImportTime > 0) {
                const duration = now - this.lastImportTime;
                this.lastItemDuration = duration;
                
                this.importDurations.push(duration);
                if (this.importDurations.length > this.MAX_N) this.importDurations.shift();
                
                // For accuracy, use a trimmed mean: remove top and bottom 10% to eliminate outliers
                const sorted = [...this.importDurations].sort((a, b) => a - b);
                const trimCount = Math.floor(sorted.length * 0.1);
                const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
                
                if (trimmed.length > 0) {
                    const sum = trimmed.reduce((a, b) => a + b, 0);
                    this.averageDuration = sum / trimmed.length;
                } else if (sorted.length > 0) {
                    // Fallback to simple average if not enough items to trim
                    this.averageDuration = sorted.reduce((a, b) => a + b, 0) / sorted.length;
                }
            }
            this.lastImportTime = now;

            const item = this.scanResults.find(r => data.path.endsWith(r.path));
            if (item) {
                item.status = 'indexed';
                item.duration = this.lastItemDuration;
                this.render();
            }
        });

        hub.sub(ps.LIBRARY_UPDATED, () => {
            this.isIndexing = false;
            this.isLocalImporting = false;
            this.lastImportTime = 0;
            this.loadLibraryInfo();
            document.title = 'Photo Library';
        });

        hub.sub(ps.FOLDER_CREATED, () => {
            this.loadLibraryInfo();
        });

        hub.sub(ps.IMPORT_FILE_FINISHED, (data) => {
            if (data && data.taskId && data.sourcePath) {
                const session = this.importSessions.get(data.taskId);
                if (session) {
                    const status: ImportStatus = {
                        status: data.success ? 'success' : 'error',
                        error: data.error,
                        targetPath: data.targetPath,
                        fileEntryId: data.fileEntryId
                    };
                    session.progress.set(data.sourcePath, status);
                    
                    // Update source list state
                    if (data.success || (data.error && data.error.includes("Exists"))) {
                        this.existingFiles.add(data.sourcePath);
                        this.selectedLocalFiles.delete(data.sourcePath);
                    }

                    this._renderImportSession(data.taskId);
                    this.render(); // Update scan results view
                }
            }
        });
    }

    public isInitialized() {
        return this.layout !== null;
    }

    public initLayout(containerId: string, triggerScanCallback: () => void) {
        this.containerId = containerId;
        const container = document.getElementById(containerId);
        if (!container) return;
        
        container.innerHTML = ''; // Clear previous

        const config = {
            settings: { showPopoutIcon: false },
            dimensions: { headerHeight: 45 },
            root: {
                type: 'row',
                content: [
                    { 
                        type: 'stack', 
                        width: 30,
                        content: [{ type: 'component', componentType: 'statistics', title: 'Library Statistics', isClosable: true, reorderEnabled: true }]
                    },
                    { 
                        type: 'stack', 
                        width: 70,
                        content: [
                            { type: 'component', componentType: 'locations', title: 'Index Locations', isClosable: true, reorderEnabled: true },
                            { type: 'component', componentType: 'import', title: 'Import and Index', isClosable: true, reorderEnabled: true }
                        ]
                    }
                ]
            }
        };

        // @ts-ignore
        this.layout = new GoldenLayout(container);
        const self = this;

        this.layout.registerComponentFactoryFunction('statistics', function(container: any) {
            const el = document.createElement('div');
            el.className = 'gl-component';
            container.element.append(el);
            self.statsVNode = el;
            self._renderStats();
        });

        this.layout.registerComponentFactoryFunction('locations', function(container: any) {
            const el = document.createElement('div');
            el.className = 'gl-component';
            container.element.append(el);
            self.locationsVNode = el;
            self._renderLocations();
        });

        this.layout.registerComponentFactoryFunction('import', function(container: any) {
            const el = document.createElement('div');
            el.className = 'gl-component';
            container.element.append(el);
            self.importVNode = el;
            self._renderImport();
        });

        this.layout.registerComponentFactoryFunction('import-status', function(container: any) {
            const taskId = container.state.taskId;
            const el = document.createElement('div');
            el.className = 'gl-component';
            container.element.append(el);
            
            const session = self.importSessions.get(taskId);
            if (session) {
                session.vnode = el;
                self._renderImportSession(taskId);
            }
            
            container.on('destroy', () => {
                self.importSessions.delete(taskId);
            });
        });

        // @ts-ignore
        this.layout.loadLayout(config);
        window.addEventListener('resize', () => { 
            if (container) this.layout.updateSize(container.offsetWidth, container.offsetHeight); 
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
        for (const taskId of this.importSessions.keys()) {
            this._renderImportSession(taskId);
        }
    }

    private _renderImportSession(taskId: string) {
        const session = this.importSessions.get(taskId);
        if (!session || !session.vnode) return;
        
        session.vnode = patch(session.vnode, ImportStatusTab({
            importList: session.list,
            progress: session.progress,
            friendlyName: session.friendlyName,
            onAbort: () => {
                Api.api_library_cancel_task({ taskId: taskId });
                hub.pub(ps.UI_NOTIFICATION, { message: 'Import abort requested', type: 'info' });
            },
            onShowInGrid: (id: string) => {
                hub.pub(ps.VIEW_MODE_CHANGED, { mode: 'grid', fileEntryId: id });
            }
        }));
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
        
        const pendingCount = this.scanResults.filter(r => r.status === 'pending').length;
        const estimatedRemainingTime = this.averageDuration * pendingCount;

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
                window.app.showFolderContextMenu(e, id);
            },
            onAnnotationSave: async (id: string, annotation: string, color?: string) => {
                const findNodeById = (nodes: Res.DirectoryNodeResponse[], targetId: string): Res.DirectoryNodeResponse | null => {
                    for (const node of nodes) {
                        if (node.directoryId === targetId) return node;
                        if (node.children) {
                            const found = findNodeById(node.children, targetId);
                            if (found) return found;
                        }
                    }
                    return null;
                };

                const node = findNodeById(this.quickSelectRoots, id);
                if (!node) return;
                const targetColor = color || node.color;
                await Api.api_library_set_annotation({ folderId: id, annotation, color: targetColor || undefined });
                node.annotation = annotation;
                if (targetColor) node.color = targetColor;
                this.render();
            },
            onCancelTask: (id: string) => Api.api_library_cancel_task({ taskId: `thumbnails-${id}` }),
            
            // Find & Index Props
            scanResults: this.scanResults,
            isIndexing: this.isIndexing,
            lastItemDuration: this.lastItemDuration,
            estimatedRemainingTime: estimatedRemainingTime,
            isScanning: this.isScanning,
            isCancelling: this.isCancelling,
            currentScanPath: this.currentScanPath,
            onFindNew: (path: string, limit: number) => this.findNewFiles(path, limit),
            onIndexFiles: (path: string, low: boolean, med: boolean) => this.triggerScan(path, low, med),
            onClearResults: () => {
                this.scanResults = [];
                this.render();
            },
            onCancelImport: () => {
                this.isCancelling = true;
                this.render();
                Api.api_library_cancel_task({ taskId: 'import-batch' }).then(() => {
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
                try { localStorage.setItem('import-source-path', path); } catch(e) {}
                this.render();
            },
            onScanPathChange: (path: string) => {
                this.currentScanPath = path;
                try { localStorage.setItem('import-source-path', path); } catch(e) {}
                this.render();
            },
            currentScanPath: this.currentScanPath,
            onFindLocal: (path: string) => this.findLocalFiles(path),
            isScanning: this.isLocalScanning,
            isValidating: this.isValidating,
            scanResults: this.localScanResults,
            selectedFiles: this.selectedLocalFiles,
            existingFiles: this.existingFiles,
            onToggleFile: (path: string) => this.toggleLocalFileSelection(path),
            onSelectAll: () => this.selectAllLocalFiles(),

            settings: this.importSettings,
            onSettingsChange: (s: any) => {
                this.importSettings = s;
                try { localStorage.setItem('import-settings', JSON.stringify(s)); } catch(e) {}
                this.validateImport();
                this.render();
            },
            importLocationsExpanded: this.importLocationsExpanded,
            onToggleImportLocation: (id: string) => this.toggleImportLocationExpanded(id),
            registeredRoots: this.quickSelectRoots,
            onImport: () => this.performImport(),
            isImporting: this.isLocalImporting
        };

        this.importVNode = patch(this.importVNode, LibraryImport(props));
    }

    private async validateImport() {
        if (this.localScanResults.length === 0 || !this.importSettings.targetRootId) {
            this.existingFiles.clear();
            this.render();
            return;
        }

        this.isValidating = true;
        this.render();

        const items: { [key: string]: string } = {};
        for (const file of this.localScanResults) {
            items[file.path] = this.calculateDestPath(file);
        }
        
        console.log('[Validate] Checking import for', Object.keys(items).length, 'items');

        try {
            const res = await Api.api_library_validate_import({
                targetRootId: this.importSettings.targetRootId,
                items: items
            });
            console.log('[Validate] Result:', res);
            if (res && res.existingSourceFiles) {
                this.existingFiles = new Set(res.existingSourceFiles);
                
                // Auto-deselect existing files to prevent accidental import
                let changed = false;
                for (const existing of this.existingFiles) {
                    if (this.selectedLocalFiles.has(existing)) {
                        this.selectedLocalFiles.delete(existing);
                        changed = true;
                    }
                }
            } else {
                this.existingFiles.clear();
            }
        } catch (e) {
            console.error("Validation failed", e);
        } finally {
            this.isValidating = false;
            this.render();
        }
    }

    private calculateDestPath(file: Res.ScanFileResult): string {
        const fileName = file.path.split('/').pop() || file.path;
        if (!this.importSettings.useDirectoryTemplate) {
            return fileName;
        }

        let dateTaken = new Date();
        if (file.dateTaken) {
            try { dateTaken = new Date(file.dateTaken); } catch(e) {}
        }
        
        const yyyy = dateTaken.getFullYear().toString();
        const mm = (dateTaken.getMonth() + 1).toString().padStart(2, '0');
        const dd = dateTaken.getDate().toString().padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`; // Simple format

        let subDir = this.importSettings.directoryTemplate
            .replace(/{YYYY}/g, yyyy)
            .replace(/{MM}/g, mm)
            .replace(/{DD}/g, dd)
            .replace(/{Date}/g, dateStr);
            
        subDir = subDir.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
        return subDir ? subDir + '/' + fileName : fileName;
    }

    private findDirectoryNodeById(nodes: Res.DirectoryNodeResponse[], id: string): Res.DirectoryNodeResponse | null {
        for (const node of nodes) {
            if (node.directoryId === id) return node;
            if (node.children && node.children.length > 0) {
                const found = this.findDirectoryNodeById(node.children, id);
                if (found) return found;
            }
        }
        return null;
    }

    private async performImport() {
        if (this.selectedLocalFiles.size === 0 || !this.importSettings.targetRootId) return;
        
        const sourceRoot = this.currentScanPath;
        const targetRootObj = this.findDirectoryNodeById(this.quickSelectRoots, this.importSettings.targetRootId);
        const targetName = targetRootObj ? (targetRootObj.name || targetRootObj.path) : this.importSettings.targetRootId;
        const friendlyName = `Import of ${this.selectedLocalFiles.size} photos from ${sourceRoot} to ${targetName}`;

        this.isLocalImporting = true;
        this.render();

        try {
            const res = await post('/api/library/import-local', {
                sourceRoot: this.currentScanPath,
                sourceFiles: Array.from(this.selectedLocalFiles),
                targetRootId: this.importSettings.targetRootId,
                directoryTemplate: this.importSettings.useDirectoryTemplate ? this.importSettings.directoryTemplate : "",
                generatePreview: this.importSettings.generatePreview,
                preventDuplicateName: this.importSettings.preventDuplicateName,
                preventDuplicateHash: this.importSettings.preventDuplicateHash
            });

            if (res && res.success && res.taskId) {
                const taskId = res.taskId;

                // Initialize Session
                this.importSessions.set(taskId, {
                    list: Array.from(this.selectedLocalFiles),
                    progress: new Map(),
                    friendlyName: friendlyName
                });

                // Open Status Tab
                if (this.layout && this.layout.rootItem) {
                    const newItemConfig = {
                        type: 'component',
                        componentType: 'import-status',
                        title: `Importing...`,
                        isClosable: true,
                        componentState: { taskId: taskId }
                    };
                    
                    try {
                        // Find all stacks in the layout
                        const stacks: any[] = [];
                        const findStacks = (item: any) => {
                            if (item.isStack) stacks.push(item);
                            else if (item.contentItems) item.contentItems.forEach(findStacks);
                        };
                        findStacks(this.layout.rootItem);
                        
                        // Target the stack that contains the 'import' component
                        const targetStack = stacks.find(s => s.contentItems.some((ci: any) => ci.componentType === 'import')) || stacks[stacks.length - 1];
                        
                        if (targetStack) {
                            targetStack.addItem(newItemConfig);
                            // Set the new tab as active
                            const newItem = targetStack.contentItems[targetStack.contentItems.length - 1];
                            if (newItem) targetStack.setActiveComponentItem(newItem, true, false);
                        }
                    } catch(e) { 
                        console.error("GL AddItem Error", e); 
                    }
                }

                hub.pub(ps.UI_NOTIFICATION, { message: `Import task started`, type: 'success' });
                await this.loadLibraryInfo();
            } else {
                hub.pub(ps.UI_NOTIFICATION, { message: `Import failed: ${res?.error || 'Unknown error'}`, type: 'error' });
                this.isLocalImporting = false;
                this.render();
            }
        } catch (e) {
            console.error("Import failed", e);
            hub.pub(ps.UI_NOTIFICATION, { message: 'Import request failed', type: 'error' });
            this.isLocalImporting = false;
            this.render();
        }
    }

    public async loadLibraryInfo() {
        try {
            const info = await Api.api_library_info();
            if (!info) return;
            this.infoCache = info;
            this.isIndexing = info.isIndexing;

            // Fetch quick select roots (registered folders)
            try {
                const roots = await Api.api_directories();
                this.quickSelectRoots = roots || [];
                if (this.currentScanPath === '' && this.quickSelectRoots.length > 0) {
                    this.currentScanPath = this.quickSelectRoots[0].name || '';
                }
                if (this.importSettings.targetRootId === '' && this.quickSelectRoots.length > 0) {
                    this.importSettings.targetRootId = this.quickSelectRoots[0].directoryId;
                }
                
                if (this.importSettings.targetRootId) {
                    this.expandImportDestination(this.importSettings.targetRootId);
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
                    children: undefined 
                }));
                this.render();

                if (this.currentScanPath) {
                    // Slight delay to allow render
                    setTimeout(() => this.expandToPath(this.currentScanPath), 100);
                }
            }
        } catch (e) { console.error("Failed to init FS", e); }
    }

    private async expandToPath(targetPath: string) {
        let currentNodes = this.fsRoots;
        let iterations = 0;
        
        while (iterations++ < 10) { // Safety break
            let foundNode: FSNode | null = null;
            
            for (const node of currentNodes) {
                // Check if this node is a parent of the target path
                const nPath = node.path.replace(/[/\\]+$/, ''); 
                const tPath = targetPath.replace(/[/\\]+$/, '');
                
                let isMatch = false;
                if (nPath === '' && tPath.startsWith('/')) isMatch = true; 
                else if (tPath === nPath) isMatch = true;
                else if (tPath.startsWith(nPath + '/') || tPath.startsWith(nPath + '\\')) isMatch = true;
                
                if (node.path.endsWith(':\\') && targetPath.startsWith(node.path)) isMatch = true;

                if (isMatch) {
                    foundNode = node;
                    break;
                }
            }

            if (!foundNode) break;

            // If found, expand it
            if (!foundNode.isExpanded) {
                foundNode.isExpanded = true;
                foundNode.isLoading = true;
                this.render();
                
                try {
                    const res = await Api.api_fs_list({ name: foundNode.path });
                    if (Array.isArray(res)) {
                        foundNode.children = res.map((d: any) => ({
                            path: d.path,
                            name: d.name,
                            isExpanded: false,
                            children: undefined
                        }));
                    } else {
                        foundNode.children = [];
                    }
                } catch (e) {
                    foundNode.children = [];
                } finally {
                    foundNode.isLoading = false;
                    this.render();
                }
            }

            // Scroll if matched exact
            if (foundNode.path === targetPath || foundNode.path.replace(/[/\\]+$/, '') === targetPath.replace(/[/\\]+$/, '')) {
                setTimeout(() => this.scrollToSelector(`[data-path="${targetPath}"]`), 200);
                break;
            }

            // Move deeper
            if (foundNode.children && foundNode.children.length > 0) {
                currentNodes = foundNode.children;
            } else {
                break; // Reached leaf or end of tree
            }
        }
    }

    private scrollToSelector(selector: string) {
        const el = document.querySelector(selector);
        if (el) {
            try {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch(e) {}
        }
    }

    private expandImportDestination(targetId: string) {
        if (!targetId) return;
        
        const findPath = (nodes: Res.DirectoryNodeResponse[], id: string, path: string[]): string[] | null => {
            for (const node of nodes) {
                if (node.directoryId === id) return [...path, node.directoryId];
                if (node.children) {
                    const res = findPath(node.children, id, [...path, node.directoryId]);
                    if (res) return res;
                }
            }
            return null;
        };

        const pathIds = findPath(this.quickSelectRoots, targetId, []);
        if (pathIds) {
            pathIds.forEach(id => this.importLocationsExpanded.add(id));
            this.render();
            setTimeout(() => this.scrollToSelector(`[data-id="${targetId}"]`), 500);
        }
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

    private toggleImportLocationExpanded(id: string) {
        if (this.importLocationsExpanded.has(id)) {
            this.importLocationsExpanded.delete(id);
        } else {
            this.importLocationsExpanded.add(id);
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
        const validCandidates = this.localScanResults
            .map(r => r.path)
            .filter(path => !this.existingFiles.has(path));

        const allValidSelected = validCandidates.length > 0 && validCandidates.every(path => this.selectedLocalFiles.has(path));

        if (allValidSelected) {
            this.selectedLocalFiles.clear();
        } else {
            this.selectedLocalFiles = new Set(validCandidates);
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
            if (Array.isArray(res)) {
                this.localScanResults = res;
                this.validateImport();
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
            if (Array.isArray(res)) {
                this.scanResults = res.map((f: string) => ({ path: f, status: 'pending' as const }));
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
        this.lastImportTime = Date.now();
        this.lastItemDuration = 0;
        this.importDurations = [];
        this.averageDuration = 0;
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