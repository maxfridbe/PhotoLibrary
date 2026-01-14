declare var GoldenLayout: any;
declare var $: any;

import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';
import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
import { server, post } from './CommunicationManager.js';
import { ThemeManager } from './ThemeManager.js';
import { LibraryManager } from './LibraryManager.js';
import { themes } from './themes.js';
import { GridView } from './grid.js';
import { constants } from './constants.js';

const ps = constants.pubsub;

type Photo = Res.PhotoResponse;
import { visualizeLensData } from './aperatureVis.js';

type MetadataItem = Res.MetadataItemResponse;
type RootPath = Res.RootPathResponse;
type Collection = Res.CollectionResponse;
type Stats = Res.StatsResponse;

type SortOption = 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc' | 'rating-desc' | 'size-desc';

interface FolderTreeNode {
    node: RootPath;
    children: FolderTreeNode[];
}

declare global {
    interface Window {
        app: App;
    }
}

class App {
    public layout: any;
    private themeManager: ThemeManager;
    public libraryManager: LibraryManager;
    private gridViewManager: GridView;

    private allPhotosFlat: Photo[] = []; 
    public photos: Photo[] = []; // Processed list
    
    private photoMap: Map<string, Photo> = new Map();
    private roots: RootPath[] = [];
    public userCollections: Collection[] = [];
    public stats: Stats = { totalCount: 0, pickedCount: 0, ratingCounts: [0,0,0,0,0] };
    public totalPhotos = 0;
    
    private expandedFolders: Set<string> = new Set();
    private flatFolderList: string[] = [];

    private imageUrlCache: Map<string, string> = new Map();
    private cameraThumbCache: Map<string, string> = new Map();

    public selectedId: string | null = null;
    public selectedMetadata: MetadataItem[] = [];
    public selectedRootId: string | null = null;
    public selectedCollectionId: string | null = null;
    public filterType: 'all' | 'picked' | 'rating' | 'search' | 'collection' = 'all';
    public filterRating: number = 0;
    public stackingEnabled: boolean = false;
    public sortBy: SortOption = 'date-desc';
    
    public searchResultIds: string[] = [];
    public searchTitle: string = '';
    public collectionFiles: string[] = [];

    private gridScale = 1.0;
    private isLoadingChunk = new Set<number>();
    public rotationMap = new Map<string, number>();
    private prioritySession = 1;

    public isLoupeMode = false;
    public isLibraryMode = false;
    public isIndexing = false;
    private overlayFormat = '{Filename}\n{Takendate}\n{Takentime}';
    private loupeOverlayEl: HTMLElement | null = null;

    // View methods added during layout registration
    public setViewTransform?: (r: number, s: number, pl: number, pt: number) => void;
    public rotateLeft?: () => void;
    public rotateRight?: () => void;
    public getPriority?: (id: string) => number;
    
    // Connection State
    private disconnectedAt: number | null = null;
    private isConnected: boolean = false;
    private isConnecting: boolean = false;
    private statusInterval: any = null;

    // Fullscreen state
    private isFullscreen: boolean = false;
    private isApplyingUrl = false;
    private fullscreenOverlay: HTMLElement | null = null;
    private fullscreenImgPlaceholder: HTMLImageElement | null = null;
    private fullscreenImgHighRes: HTMLImageElement | null = null;
    private fullscreenSpinner: HTMLElement | null = null;

    public libraryEl: HTMLElement | null = null;
    public workspaceEl: HTMLElement | null = null;
    public metadataEl: HTMLElement | null = null;
    public gridHeader: HTMLElement | null = null;
    public gridView: HTMLElement | null = null;
    public scrollSentinel: HTMLElement | null = null;
    public loupeView: HTMLElement | null = null;
    public filmstrip: HTMLElement | null = null;
    public loupePreviewPlaceholder: HTMLImageElement | null = null;
    public mainPreview: HTMLImageElement | null = null;
    public previewSpinner: HTMLElement | null = null;

    public metaTitleEl: HTMLElement | null = null;
    public metaVisEl: HTMLElement | null = null;
    private metaGroups: Map<string, { container: HTMLElement, rows: Map<string, HTMLElement> }> = new Map();

    private importedBatchCount = 0;
    private importedBatchTimer: any = null;
    private folderProgress: Map<string, { processed: number, total: number, thumbnailed?: number }> = new Map();

    constructor() {
        this.themeManager = new ThemeManager();
        this.libraryManager = new LibraryManager();
        this.gridViewManager = new GridView(this.imageUrlCache, this.rotationMap, (id) => {
            const index = this.photos.findIndex(p => p.id === id);
            const subPriority = index !== -1 ? (1 - (index / Math.max(1, this.photos.length))) : 0;
            const totalPriority = this.prioritySession + subPriority;
            // console.log(`[Priority] Requesting ${id} at index ${index} with priority ${totalPriority}`);
            return totalPriority;
        });

        hub.sub(ps.FOLDER_PROGRESS, (data) => {
            let prog = this.folderProgress.get(data.rootId);
            if (!prog) {
                prog = { processed: data.processed, total: data.total, thumbnailed: data.thumbnailed };
            } else {
                prog.processed = data.processed;
                prog.total = data.total;
                if (data.thumbnailed !== undefined) prog.thumbnailed = data.thumbnailed;
            }
            this.folderProgress.set(data.rootId, prog);
            this.updateFolderProgressUI(data.rootId);
        });

        hub.sub(ps.FOLDER_FINISHED, (data) => {
            this.folderProgress.delete(data.rootId);
            this.updateFolderProgressUI(data.rootId);
            this.showNotification('Thumbnail generation finished', 'success');
            this.refreshDirectories(); // Refresh stats from DB
        });

        this.themeManager.loadSettings().then(() => {
            this.themeManager.populateThemesDropdown();
            this.themeManager.applyTheme();
            this.initLayout();
            this.loadData();
            this.setupGlobalKeyboard();
            this.setupContextMenu();
            this.initPubSub();
            this.startStatusTimer();
            window.addEventListener('hashchange', () => this.applyUrlState());
            
            // Check initial connection state
            if (server.isConnected) {
                this.isConnected = true;
                this.updateStatusUI();
            }
        });
    }

    public setTheme(name: string) { this.themeManager.setTheme(name); }

    public async setOverlayFormat(format: string) {
        await this.themeManager.setOverlayFormat(format);
        if (this.selectedId) this.updateLoupeOverlay(this.selectedId);
    }

    private updateLoupeOverlay(id: string) {
        if (!this.loupeOverlayEl) return;
        const photo = this.photoMap.get(id);
        if (!photo || !this.isLoupeMode) {
            this.loupeOverlayEl.style.display = 'none';
            return;
        }

        this.loupeOverlayEl.style.display = 'block';
        const date = new Date(photo.createdAt);
        const dateStr = date.toISOString().split('T')[0];
        const timeStr = date.toTimeString().split(' ')[0];

        let text = this.themeManager.getOverlayFormat()
            .replace(/{Filename}/g, photo.fileName || '')
            .replace(/{Takendate}/g, dateStr)
            .replace(/{Takentime}/g, timeStr);
        
        // Handle {MD:key} tags
        const mdRegex = /{MD:(.+?)}/g;
        text = text.replace(mdRegex, (match, tag) => {
            const item = this.selectedMetadata.find(m => m.tag === tag);
            return item ? (item.value || '') : '';
        });
        
        this.loupeOverlayEl.innerText = text;
    }

    private initPubSub() {
        hub.sub(ps.PHOTO_SELECTED, (data) => {
            this.selectedId = data.id;
            this.updateSelectionUI(data.id);
            this.gridViewManager.setSelected(data.id);
            this.loadMetadata(data.id);
            
            if (this.isFullscreen) {
                this.updateFullscreenImage(data.id);
                // Also update loupe in background if we are in that mode
                if (this.isLoupeMode) {
                    this.loadMainPreview(data.id);
                    this.updateLoupeOverlay(data.id);
                }
            } else if (this.isLoupeMode) {
                this.loadMainPreview(data.id);
                this.updateLoupeOverlay(data.id);
            } else {
                this.gridViewManager.scrollToPhoto(data.id);
            }
            
            if (this.workspaceEl) this.workspaceEl.focus();
            this.syncUrl();
        });

        hub.sub(ps.VIEW_MODE_CHANGED, (data) => {
            this.isLoupeMode = data.mode === 'loupe';
            this.updateViewModeUI();
            if (data.mode === 'loupe' && data.id) {
                hub.pub(ps.PHOTO_SELECTED, { id: data.id, photo: this.photoMap.get(data.id)! });
                this.updateLoupeOverlay(data.id);
            }
            this.syncUrl();
        });

        hub.sub(ps.PHOTO_UPDATED, (data) => {
            // Update local map
            this.photoMap.set(data.id, data.photo);
            
            // If it's in our current list, update it there too
            const idx = this.photos.findIndex(p => p.id === data.id);
            if (idx !== -1) this.photos[idx] = data.photo;

            const flatIdx = this.allPhotosFlat.findIndex(p => p.id === data.id);
            if (flatIdx !== -1) this.allPhotosFlat[flatIdx] = data.photo;

            this.gridViewManager.refreshStats(data.id, this.photos);
            if (this.selectedId === data.id) {
                this.updateSelectionUI(data.id);
                if (this.isLoupeMode) this.updateLoupeOverlay(data.id);
            }
        });

        hub.sub(ps.PHOTO_ROTATED, (data) => {
            this.rotationMap.set(data.id, data.rotation);
            this.gridViewManager.refreshStats(data.id, this.photos);
            
            // Update loupe
            if (this.selectedId === data.id && this.isLoupeMode) {
                if (this.mainPreview) {
                    this.mainPreview.style.transform = `rotate(${data.rotation}deg)`;
                    this.mainPreview.classList.toggle('is-portrait-rotated', data.rotation % 180 !== 0);
                }
                if (this.loupePreviewPlaceholder) {
                    this.loupePreviewPlaceholder.style.transform = `rotate(${data.rotation}deg)`;
                    this.loupePreviewPlaceholder.classList.toggle('is-portrait-rotated', data.rotation % 180 !== 0);
                }
            }

            // Update fullscreen image
            if (this.isFullscreen && this.selectedId === data.id) {
                if (this.fullscreenImgPlaceholder) this.fullscreenImgPlaceholder.style.transform = `rotate(${data.rotation}deg)`;
                if (this.fullscreenImgHighRes) this.fullscreenImgHighRes.style.transform = `rotate(${data.rotation}deg)`;
            }
        });

        hub.sub(ps.SEARCH_TRIGGERED, (data) => this.searchPhotos(data.tag, data.value));

        hub.sub(ps.SHORTCUTS_SHOW, () => document.getElementById('shortcuts-modal')?.classList.add('active'));

        hub.sub(ps.UI_LAYOUT_CHANGED, () => this.gridViewManager.update());

        hub.sub(ps.CONNECTION_CHANGED, (data) => {
            this.isConnected = data.connected;
            this.isConnecting = data.connecting;
            if (data.connected) this.disconnectedAt = null;
            else if (!data.connecting) this.disconnectedAt = Date.now();
            this.updateStatusUI();
        });

        hub.sub(ps.PREVIEW_DELETED, (data) => {
            const cacheKey = data.fileId + '-300';
            this.imageUrlCache.delete(cacheKey);
            this.imageUrlCache.delete(data.fileId + '-2000');
            this.gridViewManager.refreshStats(data.fileId, this.photos);
        });

        hub.sub(ps.UI_NOTIFICATION, (data) => this.showNotification(data.message, data.type));

        hub.sub(ps.LIBRARY_UPDATED, () => {
            this.isIndexing = false;
            this.loadData();
            this.showNotification('Library updated', 'success');
        });

        hub.sub(ps.PHOTO_IMPORTED, (data) => {
            this.importedBatchCount++;
            if (this.importedBatchTimer) clearTimeout(this.importedBatchTimer);
            this.importedBatchTimer = setTimeout(() => {
                this.showNotification(`Imported ${this.importedBatchCount} photos`, 'success');
                this.importedBatchCount = 0;
                this.loadData();
            }, 1000);
        });

        hub.sub(ps.PREVIEW_GENERATED, (data) => {
            this.gridViewManager.refreshStats(data.fileId, this.photos);
            if (data.rootId) {
                let prog = this.folderProgress.get(data.rootId);
                if (!prog) {
                    const root = this.roots.find(r => r.id === data.rootId);
                    if (root) {
                        prog = { processed: root.thumbnailedCount, total: root.imageCount, thumbnailed: root.thumbnailedCount };
                    }
                }
                if (prog) {
                    prog.thumbnailed = (prog.thumbnailed || 0) + 1;
                    prog.processed = Math.max(prog.processed, prog.thumbnailed); // Keep processed in sync for fallback
                    this.folderProgress.set(data.rootId, prog);
                    this.updateFolderProgressUI(data.rootId);
                }
            }
        });
    }

    private startStatusTimer() {
        this.statusInterval = setInterval(() => {
            if (this.disconnectedAt !== null) {
                this.updateStatusUI();
            }
        }, 1000);
    }

    public setSort(opt: SortOption) {
        this.sortBy = opt;
        this.processUIStacks();
        this.syncUrl();
    }

    public toggleStacking(enabled: boolean) {
        this.stackingEnabled = enabled;
        this.processUIStacks();
        this.syncUrl();
    }

    private savePhotoPreferences(id: string, rotation: number) {
        const photo = this.photoMap.get(id);
        if (!photo || !photo.hash) return;

        // Fetch existing prefs if any, or just save rotation
        // We only persist rotation for now via this method
        // Note: The workspace/loupe view has its own save logic which includes zoom/pan
        // But for global rotation hotkeys, we just want to save rotation.
        // If we want to preserve zoom/pan, we'd need to fetch -> update -> save.
        // But since we are likely not in loupe view or just rotating, reset zoom/pan makes sense or keep defaults.
        
        const prefs = {
            rotation: rotation,
            zoom: 1,
            panL: 0,
            panT: 0
        };

        Api.api_settings_set({ 
            key: `${photo.hash}-pref-img`, 
            value: JSON.stringify(prefs) 
        });
    }

    private handlePhotoUpdate(photo: Photo) {
        this.photoMap.set(photo.id, photo);
        const updateTargets = photo.stackFileIds && photo.stackFileIds.length > 0 ? photo.stackFileIds : [photo.id];
        
        this.allPhotosFlat.forEach(p => {
            if (p && updateTargets.includes(p.id)) {
                p.isPicked = photo.isPicked;
                p.rating = photo.rating;
            }
        });

        this.processUIStacks();
        
        const rep = this.photos.find(p => p.id === photo.id || (p.stackFileIds && p.stackFileIds.includes(photo.id)));
        if (rep) {
            this.gridViewManager.refreshStats(rep.id, this.photos);
        }
        
        if (this.selectedId === photo.id) this.loadMetadata(photo.id);
    }

    private processUIStacks() {
        let result: Photo[] = [];

        if (!this.stackingEnabled) {
            result = this.allPhotosFlat.map(p => ({
                ...p, 
                stackCount: 1, 
                stackFileIds: [p.id], 
                stackExtensions: p.fileName!.split('.').pop()?.toUpperCase()
            }));
        } else {
            const groups = new Map<string, Photo[]>();
            this.allPhotosFlat.forEach(p => {
                const extIdx = p.fileName?.lastIndexOf('.') || -1;
                const base = extIdx > 0 ? p.fileName!.substring(0, extIdx) : p.fileName!;
                const key = `${p.rootPathId}|${base}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key)!.push(p);
            });

            result = Array.from(groups.values()).map(group => {
                group.sort((a, b) => {
                    const getRank = (fn: string) => {
                        const ext = fn.split('.').pop()?.toUpperCase();
                        const rawExts = ['ARW', 'NEF', 'CR2', 'CR3', 'DNG', 'RAF', 'RW2', 'ORF'];
                        if (rawExts.includes(ext!)) return 0;
                        if (ext === 'JPG' || ext === 'JPEG') return 1;
                        return 2;
                    };
                    return getRank(a.fileName!) - getRank(b.fileName!);
                });

                const rep = { ...group[0] };
                rep.stackCount = group.length;
                rep.stackFileIds = group.map(p => p.id);
                rep.isPicked = group.some(p => p.isPicked);
                rep.rating = Math.max(...group.map(p => p.rating));
                
                const exts = Array.from(new Set(group.map(p => p.fileName!.split('.').pop()?.toUpperCase())));
                exts.sort();
                rep.stackExtensions = exts.join(' + ');

                return rep;
            });
        }

        result.sort((a, b) => {
            switch (this.sortBy) {
                case 'date-desc': return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                case 'date-asc': return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
                case 'name-asc': return (a.fileName || '').localeCompare(b.fileName || '');
                case 'name-desc': return (b.fileName || '').localeCompare(a.fileName || '');
                case 'rating-desc': return b.rating - a.rating;
                case 'size-desc': return b.size - a.size;
                default: return 0;
            }
        });

        this.photos = result;
        this.totalPhotos = this.photos.length;
        this.gridViewManager.setPhotos(this.photos);
        
        this.renderGrid();
        if (this.isLoupeMode) this.renderFilmstrip();
    }

    private clearMetadata() {
        if (this.metadataEl) this.metadataEl.innerHTML = '';
        this.metaTitleEl = null;
        this.metaGroups.clear();
    }

    public showNotification(message: string, type: 'info' | 'error' | 'success') {
        const container = document.getElementById('notifications');
        if (!container) return;
        const el = document.createElement('div');
        el.style.padding = '0.8em 1.5em';
        el.style.borderRadius = '4px';
        el.style.color = '#fff';
        el.style.fontSize = '0.9em';
        el.style.boxShadow = '0 4px 12px rgba(0,0,0,0.4)';
        el.style.pointerEvents = 'auto';
        el.style.minWidth = '200px';
        el.style.transition = 'all 0.3s ease';
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.background = type === 'error' ? '#d32f2f' : (type === 'success' ? '#388e3c' : '#333');
        el.textContent = message;
        container.appendChild(el);
        
        // Trigger entrance animation
        setTimeout(() => {
            el.style.opacity = '1';
            el.style.transform = 'translateY(0)';
        }, 10);

        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(-20px)';
            setTimeout(() => el.remove(), 300);
        }, 3000);
    }

    private updateStatusUI() {
        const el = document.getElementById('connection-status');
        if (!el) return;

        if (this.isConnected) {
            el.textContent = 'Connected';
            el.style.color = '#0f0';
            return;
        }

        const secs = this.disconnectedAt ? Math.floor((Date.now() - this.disconnectedAt) / 1000) : 0;
        let time = secs + 's';
        if (secs > 60) time = Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';

        if (this.isConnecting) {
            el.innerHTML = '';
            const s = document.createElement('span');
            s.className = 'spinner';
            s.style.display = 'inline-block';
            s.style.width = '10px'; s.style.height = '10px';
            s.style.verticalAlign = 'middle'; s.style.marginRight = '5px';
            el.appendChild(s);
            el.appendChild(document.createTextNode(`Connecting... (${time} offline)`));
            el.style.color = '#aaa';
        } else {
            el.textContent = `Disconnected (${time} ago)`;
            el.style.color = '#f00';
        }
    }

    async refreshStatsOnly() {
        this.stats = await Api.api_stats({});
        this.updateSidebarCountsOnly();
    }

    async refreshDirectories() {
        this.roots = await Api.api_directories({});
        this.renderLibrary();
    }

    private updateSidebarCountsOnly() {
        if (!this.libraryEl) return;
        const allCountEl = this.libraryEl.querySelector('.tree-item[data-type="all"] .count');
        if (allCountEl) allCountEl.textContent = this.stats.totalCount.toString();

        const pickedCountEl = this.libraryEl.querySelector('.tree-item[data-type="picked"] .count');
        if (pickedCountEl) pickedCountEl.textContent = this.stats.pickedCount.toString();
        for (let i = 1; i <= 5; i++) {
            const countEl = this.libraryEl.querySelector(`.tree-item[data-type="rating-${i}"] .count`);
            if (countEl) countEl.textContent = this.stats.ratingCounts[i-1].toString();
        }
    }

    private syncUrl() {
        if (this.isApplyingUrl) return;
        
        let mode = 'grid';
        if (this.isLoupeMode) mode = 'loupe';
        else if (this.isLibraryMode) mode = 'library';

        let filterPart = 'all';
        if (this.selectedRootId) filterPart = `folder/${this.selectedRootId}`;
        else if (this.selectedCollectionId) filterPart = `collection/${this.selectedCollectionId}`;
        else if (this.filterType === 'picked') filterPart = 'picked';
        else if (this.filterType === 'rating') filterPart = `rating/${this.filterRating}`;
        else if (this.filterType === 'search') filterPart = `search/${encodeURIComponent(this.searchTitle)}`;

        const photoPart = (this.selectedId && !this.isLibraryMode) ? `/${this.selectedId}` : '';
        const params = new URLSearchParams();
        params.set('sort', this.sortBy);
        params.set('size', this.gridScale.toString());
        params.set('stacked', this.stackingEnabled.toString());

        const newHash = `#!/${mode}/${filterPart}${photoPart}?${params.toString()}`;
        if (window.location.hash !== newHash) {
            window.location.hash = newHash;
        }
    }

    private async applyUrlState() {
        const hash = window.location.hash;
        if (!hash.startsWith('#!/')) return;
        
        this.isApplyingUrl = true;
        try {
            const [pathPart, queryPart] = hash.substring(3).split('?');
            const parts = pathPart.split('/');
            if (parts.length < 2) return;

            const mode = parts[0];
            const type = parts[1];
            
            this.isLoupeMode = (mode === 'loupe');
            this.isLibraryMode = (mode === 'library');

            let sortChanged = false;
            let stackChanged = false;

            // Handle query params
            if (queryPart) {
                const params = new URLSearchParams(queryPart);
                if (params.has('sort')) {
                    const newSort = params.get('sort') as SortOption;
                    if (newSort !== this.sortBy) { this.sortBy = newSort; sortChanged = true; }
                }
                if (params.has('size')) {
                    const newScale = parseFloat(params.get('size')!);
                    if (Math.abs(newScale - this.gridScale) > 0.001) {
                        this.gridScale = newScale;
                        document.documentElement.style.setProperty('--card-min-width', (12.5 * this.gridScale) + 'em');
                        document.documentElement.style.setProperty('--card-height', (13.75 * this.gridScale) + 'em');
                        this.gridViewManager.setScale(this.gridScale);
                    }
                }
                if (params.has('stacked')) {
                    const newStack = params.get('stacked') === 'true';
                    if (newStack !== this.stackingEnabled) { this.stackingEnabled = newStack; stackChanged = true; }
                }
            }
            
            let newFilterType = this.filterType;
            let newRootId: string | null = null;
            let newCollectionId: string | null = null;
            let newRating = 0;
            let newSearchTitle = '';

            if (type === 'folder' && parts[2]) {
                newFilterType = 'all';
                newRootId = parts[2];
            } else if (type === 'collection' && parts[2]) {
                newFilterType = 'collection';
                newCollectionId = parts[2];
            } else if (type === 'picked') {
                newFilterType = 'picked';
            } else if (type === 'rating' && parts[2]) {
                newFilterType = 'rating';
                newRating = parseInt(parts[2]);
            } else if (type === 'search' && parts[2]) {
                newFilterType = 'search';
                newSearchTitle = decodeURIComponent(parts[2]);
            } else {
                newFilterType = 'all';
                newRootId = null;
            }

            const filterChanged = newFilterType !== this.filterType || newRootId !== this.selectedRootId || newCollectionId !== this.selectedCollectionId || newRating !== this.filterRating || newSearchTitle !== this.searchTitle;

            if (filterChanged) {
                this.prioritySession++;
                this.filterType = newFilterType as 'all' | 'picked' | 'rating' | 'search' | 'collection';
                this.selectedRootId = newRootId;
                this.selectedCollectionId = newCollectionId;
                this.filterRating = newRating;
                this.searchTitle = newSearchTitle;
                
                if (this.filterType === 'collection' && this.selectedCollectionId) {
                    this.collectionFiles = await Api.api_collections_get_files({ id: this.selectedCollectionId });
                } else if (this.filterType === 'search') {
                    this.searchResultIds = await Api.api_search({ tag: 'FileName', value: this.searchTitle });
                }
                await this.refreshPhotos(true);
            } else if (sortChanged || stackChanged) {
                this.processUIStacks();
            }

            // Selected ID is usually the last part if it exists and looks like a GUID or similar
            // Based on our logic, it's at index 2 (for 'all', 'picked') or 3 (for 'folder', 'collection', 'rating', 'search')
            let idFromUrl = '';
            if (['all', 'picked'].includes(type)) idFromUrl = parts[2];
            else idFromUrl = parts[3];
            
            if (idFromUrl && idFromUrl !== this.selectedId) {
                const p = this.photoMap.get(idFromUrl);
                if (p) {
                    this.selectedId = idFromUrl;
                    hub.pub(ps.PHOTO_SELECTED, { id: p.id, photo: p });
                }
            } else if (!idFromUrl && this.selectedId) {
                // Deselection via URL? Usually we want to keep selection unless explicit.
                // But if URL has no ID, and we are in grid mode, maybe we should clear?
                // For now, let's assume navigating to a folder view without ID means no selection.
                // this.selectedId = null;
                // hub.pub(ps.PHOTO_SELECTED, { id: '', photo: null as any }); 
            }

            this.updateHeaderUI();
            this.updateViewModeUI();
            if (this.isLibraryMode) this.libraryManager.loadLibraryInfo();
        } finally {
            this.isApplyingUrl = false;
        }
    }

    private updateHeaderUI() {
        const sortSelect = document.getElementById('grid-sort-select') as HTMLSelectElement;
        if (sortSelect) sortSelect.value = this.sortBy;

        const stackCheck = document.getElementById('grid-stack-check') as HTMLInputElement;
        if (stackCheck) stackCheck.checked = this.stackingEnabled;

        const scaleSlider = document.getElementById('grid-scale-slider') as HTMLInputElement;
        if (scaleSlider) scaleSlider.value = this.gridScale.toString();
    }

    async loadData() {
        try {
            const [roots, colls, stats, expState] = await Promise.all([
                Api.api_directories({}),
                Api.api_collections_list({}),
                Api.api_stats({}),
                Api.api_settings_get({ name: 'folder-expanded-state' })
            ]);
            this.roots = roots;
            this.userCollections = colls;
            this.stats = stats;

            if (expState && expState.value) {
                try {
                    const ids = JSON.parse(expState.value);
                    if (Array.isArray(ids)) this.expandedFolders = new Set(ids);
                } catch (e) { console.error("Failed to parse expanded folders", e); }
            }
            
            if (window.location.hash.startsWith('#!/')) {
                await this.applyUrlState();
            } else {
                await this.refreshPhotos();
            }
        } catch (e) { console.error("Load failed", e); }
    }

    async refreshPhotos(keepSelection: boolean = false) {
        this.allPhotosFlat = [];
        this.photos = [];
        this.gridViewManager.clearCache();
        this.isLoadingChunk.clear();
        
        const params: Req.PagedPhotosRequest = { 
            limit: 100000, offset: 0, 
            rootId: this.selectedRootId || undefined, 
            pickedOnly: this.filterType === 'picked', 
            rating: this.filterRating, 
            specificIds: (this.filterType === 'collection' ? this.collectionFiles : (this.filterType === 'search' ? this.searchResultIds : undefined)) 
        };
        const [data, stats] = await Promise.all([ Api.api_photos(params), Api.api_stats({}) ]);
        
        this.allPhotosFlat = data.photos as Photo[];
        this.photoMap.clear();
        this.allPhotosFlat.forEach(p => {
            this.photoMap.set(p.id, p);
            if (p.rotation) this.rotationMap.set(p.id, p.rotation);
        });
        
        this.stats = stats;
        this.photos = this.allPhotosFlat;

        // Initialize folder progress counts from current state
        this.roots.forEach(r => {
            if (!this.folderProgress.has(r.id)) {
                // Only show initial bar if significant work is missing (> 5%)
                if (r.thumbnailedCount < r.imageCount * 0.95) {
                    this.folderProgress.set(r.id, { processed: r.thumbnailedCount, total: r.imageCount, thumbnailed: r.thumbnailedCount });
                }
            }
        });

        this.gridViewManager.setPhotos(this.photos);
        this.renderLibrary();
        this.processUIStacks();

        if (!keepSelection && this.photos.length > 0) {
            hub.pub(ps.PHOTO_SELECTED, { id: this.photos[0].id, photo: this.photos[0] });
        }
    }

    public resetLayout() {
        if (this.layout) {
            this.layout.destroy();
            this.layout = null;
        }
        document.getElementById('layout-container')!.innerHTML = '';
        this.initLayout();
        document.getElementById('settings-modal')?.classList.remove('active');
        this.showNotification('Layout reset to default', 'success');
    }

    private initLayout() {
        const config = {
            settings: { showPopoutIcon: false },
            content: [{
                type: 'row',
                content: [
                    { type: 'component', componentName: 'library', width: 20, title: 'Library', isClosable: false },
                    { type: 'component', componentName: 'workspace', width: 60, title: 'Photos', isClosable: false },
                    { type: 'component', componentName: 'metadata', width: 20, title: 'Metadata' }
                ]
            }]
        };
        this.layout = new GoldenLayout(config, '#layout-container');
        const self = this;
        this.layout.registerComponent('library', function(container: any) {
            const wrapper = document.createElement('div');
            wrapper.style.display = 'flex';
            wrapper.style.flexDirection = 'column';
            wrapper.style.height = '100%';

            const libHeader = document.createElement('div');
            libHeader.style.padding = '5px 10px';
            libHeader.style.borderBottom = '1px solid var(--border-color)';
            libHeader.style.display = 'flex';
            libHeader.style.justifyContent = 'space-between';
            libHeader.style.alignItems = 'center';
            libHeader.style.background = 'var(--bg-header)';
            
            const title = document.createElement('span');
            title.textContent = 'Library';
            title.style.fontWeight = 'bold';
            
            const collapseBtn = document.createElement('span');
            collapseBtn.innerHTML = '&#171;'; // <<
            collapseBtn.style.cursor = 'pointer';
            collapseBtn.title = 'Minimize (B)';
            collapseBtn.onclick = () => self.toggleLibraryPanel();

            libHeader.appendChild(title);
            libHeader.appendChild(collapseBtn);
            wrapper.appendChild(libHeader);

            self.libraryEl = document.createElement('div');
            self.libraryEl.className = 'tree-view';
            self.libraryEl.style.flex = '1';
            self.libraryEl.style.overflowY = 'auto';
            
            wrapper.appendChild(self.libraryEl);
            container.getElement().append(wrapper);
            
            // Hide the expand button in workspace if library is visible
            const expandBtn = document.getElementById('lib-expand-btn');
            if (expandBtn) expandBtn.style.display = 'none';

            if (self.photos.length > 0) self.renderLibrary();
        });
        this.layout.registerComponent('workspace', function(container: any) {
            console.log('[App] Workspace component initializing...');
            self.workspaceEl = document.createElement('div');
            self.workspaceEl.className = 'gl-component';
            self.workspaceEl.style.overflow = 'hidden';
            
            const header = document.createElement('div');
            header.id = 'grid-header';
            header.className = 'grid-header';
            
            const headerLeft = document.createElement('div');
            headerLeft.style.display = 'flex';
            headerLeft.style.alignItems = 'center';
            headerLeft.style.gap = '10px';

            const expandLibBtn = document.createElement('span');
            expandLibBtn.id = 'lib-expand-btn';
            expandLibBtn.innerHTML = '&#187;'; // >>
            expandLibBtn.style.cursor = 'pointer';
            expandLibBtn.style.display = 'none'; // Hidden by default as library is open
            expandLibBtn.style.fontSize = '1.2em';
            expandLibBtn.style.fontWeight = 'bold';
            expandLibBtn.title = 'Show Library (B)';
            expandLibBtn.onclick = () => self.toggleLibraryPanel();
            
            const headerText = document.createElement('span');
            headerText.id = 'header-text';
            headerText.textContent = 'All Photos';

            headerLeft.appendChild(expandLibBtn);
            headerLeft.appendChild(headerText);
            
            const headerRight = document.createElement('div');
            headerRight.style.display = 'flex';
            headerRight.style.alignItems = 'center';
            headerRight.style.gap = '15px';

            const scaleLabel = document.createElement('label');
            scaleLabel.className = 'control-item';
            scaleLabel.title = 'Adjust thumbnail size';
            const scaleInput = document.createElement('input');
            scaleInput.id = 'grid-scale-slider';
            scaleInput.type = 'range';
            scaleInput.min = '0.5';
            scaleInput.max = '2.0';
            scaleInput.step = '0.1';
            scaleInput.value = self.gridScale.toString();
            scaleInput.style.width = '80px';
            scaleInput.oninput = (e) => {
                const scale = parseFloat((e.target as HTMLInputElement).value);
                self.gridScale = scale;
                self.gridViewManager.setScale(scale);
                self.syncUrl();
            };
            scaleLabel.appendChild(document.createTextNode('Size: '));
            scaleLabel.appendChild(scaleInput);

            const sortLabel = document.createElement('label');
            sortLabel.className = 'control-item';
            sortLabel.textContent = 'Sort: ';
            const sortSelect = document.createElement('select');
            sortSelect.id = 'grid-sort-select';
            sortSelect.style.background = '#111'; sortSelect.style.color = '#ccc'; sortSelect.style.border = '1px solid #444'; sortSelect.style.fontSize = '0.9em';
            const options: {val: SortOption, text: string}[] = [
                { val: 'date-desc', text: 'Date (Newest)' },
                { val: 'date-asc', text: 'Date (Oldest)' },
                { val: 'name-asc', text: 'Name (A-Z)' },
                { val: 'name-desc', text: 'Name (Z-A)' },
                { val: 'rating-desc', text: 'Rating' },
                { val: 'size-desc', text: 'Size' }
            ];
            options.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.val; opt.textContent = o.text;
                if (o.val === self.sortBy) opt.selected = true;
                sortSelect.appendChild(opt);
            });
            sortSelect.onchange = (e) => self.setSort((e.target as HTMLSelectElement).value as SortOption);
            sortLabel.appendChild(sortSelect);

            const stackLabel = document.createElement('label');
            stackLabel.className = 'control-item';
            stackLabel.title = 'Stack JPG/RAW files with same name';
            const stackCheck = document.createElement('input');
            stackCheck.id = 'grid-stack-check';
            stackCheck.type = 'checkbox';
            stackCheck.checked = self.stackingEnabled;
            stackCheck.onchange = (e) => self.toggleStacking((e.target as HTMLInputElement).checked);
            const stackSpan = document.createElement('span');
            stackSpan.textContent = 'Stacked';
            stackLabel.appendChild(stackCheck);
            stackLabel.appendChild(stackSpan);

            const headerCount = document.createElement('span');
            headerCount.id = 'header-count';
            headerCount.textContent = '0 items';
            
            headerRight.appendChild(scaleLabel);
            headerRight.appendChild(sortLabel);
            headerRight.appendChild(stackLabel);
            headerRight.appendChild(headerCount);

            header.appendChild(headerLeft);
            header.appendChild(headerRight);
            self.workspaceEl.appendChild(header);

            const gridContainer = document.createElement('div');
            gridContainer.id = 'grid-container';
            gridContainer.style.flex = '1';
            gridContainer.style.overflowY = 'auto';
            (gridContainer.style as CSSStyleDeclaration & { scrollbarGutter: string }).scrollbarGutter = 'stable';
            gridContainer.style.position = 'relative';
            const sentinel = document.createElement('div');
            sentinel.id = 'scroll-sentinel';
            sentinel.style.position = 'absolute';
            sentinel.style.top = '0'; sentinel.style.left = '0'; sentinel.style.right = '0'; sentinel.style.height = '0'; sentinel.style.pointerEvents = 'none';
            const gridView = document.createElement('div');
            gridView.id = 'grid-view';
            gridView.className = 'grid-view';
            gridView.style.position = 'absolute';
            gridView.style.top = '0'; gridView.style.left = '0'; gridView.style.right = '0';
            gridContainer.appendChild(sentinel);
            gridContainer.appendChild(gridView);
            self.workspaceEl.appendChild(gridContainer);

            gridContainer.onscroll = () => self.gridViewManager.update();
            console.log('[App] Assigning gridViewEl to manager');
            self.gridViewManager.gridViewEl = gridView;
            self.gridViewManager.scrollSentinel = sentinel;
            if (self.photos.length > 0) self.gridViewManager.update(true);

            const loupeView = document.createElement('div');
            loupeView.id = 'loupe-view';
            loupeView.className = 'loupe-view';
            loupeView.style.display = 'none';
            loupeView.style.height = '100%';
            
            const previewArea = document.createElement('div');
            previewArea.className = 'preview-area';
            
            const overlay = document.createElement('div');
            overlay.className = 'loupe-overlay';
            overlay.id = 'loupe-overlay';
            self.loupeOverlayEl = overlay;

            const spinner = document.createElement('div');
            spinner.className = 'spinner center-spinner';
            spinner.id = 'preview-spinner';
            
            const imgP = document.createElement('img');
            imgP.id = 'loupe-preview-placeholder';
            imgP.className = 'loupe-img placeholder';
            
            const imgH = document.createElement('img');
            imgH.id = 'main-preview';
            imgH.className = 'loupe-img highres';

            
            // Zoom Toolbar
            const zoomToolbar = document.createElement('div');
            zoomToolbar.className = 'zoom-toolbar';
            zoomToolbar.style.cssText = 'position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.6); backdrop-filter: blur(5px); padding: 5px 15px; border-radius: 20px; display: flex; gap: 15px; align-items: center; color: white; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 100; border: 1px solid rgba(255,255,255,0.2);';
            
            const btnRotateLeft = document.createElement('span'); btnRotateLeft.innerHTML = '&#8634;'; btnRotateLeft.style.cssText = 'cursor: pointer; font-weight: bold; padding: 0 5px; pointer-events: auto; font-size: 1.2em;'; btnRotateLeft.title = 'Rotate Left ([)';
            const btnMinus = document.createElement('span'); btnMinus.textContent = '-'; btnMinus.style.cssText = 'cursor: pointer; font-weight: bold; padding: 0 5px; pointer-events: auto;';
            const zoomLevel = document.createElement('span'); zoomLevel.textContent = '100%'; zoomLevel.style.cssText = 'font-variant-numeric: tabular-nums; width: 3em; text-align: center;';
            const btnPlus = document.createElement('span'); btnPlus.textContent = '+'; btnPlus.style.cssText = 'cursor: pointer; font-weight: bold; padding: 0 5px; pointer-events: auto;';
            const btnOneToOne = document.createElement('span'); btnOneToOne.textContent = '1:1'; btnOneToOne.style.cssText = 'cursor: pointer; font-weight: bold; padding: 0 5px; pointer-events: auto; font-size: 0.8em; border: 1px solid white; border-radius: 4px; display: none;'; btnOneToOne.title = 'Zoom to Device Pixels';
            const btnRotateRight = document.createElement('span'); btnRotateRight.innerHTML = '&#8635;'; btnRotateRight.style.cssText = 'cursor: pointer; font-weight: bold; padding: 0 5px; pointer-events: auto; font-size: 1.2em;'; btnRotateRight.title = 'Rotate Right (])';
            
            zoomToolbar.appendChild(btnRotateLeft);
            zoomToolbar.appendChild(btnMinus);
            zoomToolbar.appendChild(zoomLevel);
            zoomToolbar.appendChild(btnPlus);
            zoomToolbar.appendChild(btnOneToOne);
            zoomToolbar.appendChild(btnRotateRight);

            previewArea.appendChild(spinner);
            previewArea.appendChild(overlay);
            previewArea.appendChild(imgP);
            previewArea.appendChild(imgH);
            previewArea.appendChild(zoomToolbar);
            
            // Zoom & Rotate Logic Variables
            let scale = 1;
            let rotation = 0;
            let pX = 0, pY = 0;
            let isDragging = false;
            let startX = 0, startY = 0;
            let zoomTimer: any = null;
            let isFullResLoaded = false;
            let savePrefsTimer: any = null;

            const showToolbar = () => {
                zoomToolbar.style.opacity = '1';
                if (zoomTimer) clearTimeout(zoomTimer);
                zoomTimer = setTimeout(() => zoomToolbar.style.opacity = '0', 2000);
            };

            const saveViewPrefs = () => {
                if (!self.selectedId) return;
                const photo = self.photoMap.get(self.selectedId);
                if (!photo || !photo.hash) return;

                // Don't save if everything is default
                if (rotation === 0 && scale === 1 && pX === 0 && pY === 0) return;

                const prefs = {
                    rotation,
                    zoom: scale,
                    panL: pX / previewArea.clientWidth,
                    panT: pY / previewArea.clientHeight
                };

                Api.api_settings_set({ 
                    key: `${photo.hash}-pref-img`, 
                    value: JSON.stringify(prefs) 
                });
            };

            const loadFullRes = () => {
                if (!self.selectedId || isFullResLoaded) return;
                isFullResLoaded = true; // Mark as requested to prevent dupes
                
                const id = self.selectedId;
                const fullResKey = id + '-full';
                
                const applyFullRes = (url: string) => {
                    imgH.src = url;
                    // Show 1:1 button when high res is ready
                    imgH.onload = () => {
                        if (self.selectedId === id) {
                            btnOneToOne.style.display = 'inline-block';
                            showToolbar();
                        }
                    };
                };

                if (self.imageUrlCache.has(fullResKey)) {
                    applyFullRes(self.imageUrlCache.get(fullResKey)!);
                    return;
                }

                // Request size 0 for original
                server.requestImage(id, 0).then((blob: Blob) => {
                    if (self.selectedId === id) {
                        const url = URL.createObjectURL(blob);
                        self.imageUrlCache.set(fullResKey, url);
                        applyFullRes(url);
                    }
                });
            };

            const updateTransform = (skipSave = false, skipTransition = false) => {
                const transform = `translate(${pX}px, ${pY}px) scale(${scale}) rotate(${rotation}deg)`;
                
                imgP.style.transition = 'transform 0.2s';
                imgH.style.transition = 'transform 0.2s';
                
                if (isDragging || skipTransition) {
                    imgP.style.transition = 'none';
                    imgH.style.transition = 'none';
                }

                imgP.style.transform = transform;
                imgH.style.transform = transform;
                zoomLevel.textContent = Math.round(scale * 100) + '%';
                
                // Cursor logic
                if (scale > 1) previewArea.style.cursor = isDragging ? 'grabbing' : 'grab';
                else previewArea.style.cursor = 'default';

                // Load full res if zoomed in past 150%
                if (scale > 1.5 && !isFullResLoaded) {
                    loadFullRes();
                }

                if (!skipSave) {
                    if (savePrefsTimer) clearTimeout(savePrefsTimer);
                    savePrefsTimer = setTimeout(saveViewPrefs, 1000);
                }
            };

            // Expose for restore
            self.setViewTransform = (r: number, s: number, pl: number, pt: number) => {
                rotation = r; scale = s;
                // Restore pan from percentages
                pX = pl * previewArea.clientWidth;
                pY = pt * previewArea.clientHeight;
                updateTransform(true, true); // skip save and transition on restore
                if (self.selectedId) hub.pub(ps.PHOTO_ROTATED, { id: self.selectedId, rotation });
            };

            // Controls
            const triggerRotate = () => {
                updateTransform();
                showToolbar();
                if (self.selectedId) hub.pub(ps.PHOTO_ROTATED, { id: self.selectedId, rotation });
            };

            btnRotateLeft.onclick = (e) => { e.stopPropagation(); rotation -= 90; triggerRotate(); };
            btnRotateRight.onclick = (e) => { e.stopPropagation(); rotation += 90; triggerRotate(); };
            btnMinus.onclick = (e) => { e.stopPropagation(); scale = Math.max(0.1, scale - 0.1); if(scale<=1) { pX=0; pY=0; } updateTransform(); showToolbar(); };
            btnPlus.onclick = (e) => { e.stopPropagation(); scale = Math.min(5, scale + 0.1); updateTransform(); showToolbar(); };
            
            btnOneToOne.onclick = (e) => {
                e.stopPropagation();
                if (!imgH.complete || imgH.naturalWidth === 0) return;

                // Calculate scale for 1 image pixel : 1 physical device pixel
                // Current rendered width at scale 1 (Fit)
                const containerW = previewArea.clientWidth;
                const containerH = previewArea.clientHeight;
                const imgW = imgH.naturalWidth;
                const imgH_h = imgH.naturalHeight;
                
                const aspectImg = imgW / imgH_h;
                const aspectContainer = containerW / containerH;
                
                let renderedW, renderedH;
                if (aspectImg > aspectContainer) {
                    // Limited by width
                    renderedW = containerW;
                    renderedH = containerW / aspectImg;
                } else {
                    // Limited by height
                    renderedH = containerH;
                    renderedW = containerH * aspectImg;
                }
                
                const scale1to1 = imgW / renderedW; 
                // devicePixelRatio logic:
                // logical pixels = physical / devicePixelRatio
                // we want 1 CSS pixel = 1 image pixel? No, usually 1:1 means 1 image pixel = 1 CSS pixel.
                // "Zoom to device pixels" means 1 image pixel = 1 physical pixel.
                // So if DPR is 2 (Retina), we want displayed CSS width = imgW / 2.
                // Target CSS width = imgW / window.devicePixelRatio
                // Target Scale = (imgW / window.devicePixelRatio) / renderedW
                
                const targetScale = (imgW / window.devicePixelRatio) / renderedW;
                
                scale = targetScale;
                pX = 0; pY = 0; // Center it
                updateTransform();
                showToolbar();
            };

            // Wheel Zoom
            previewArea.onwheel = (e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                const newScale = Math.max(0.1, Math.min(5, scale + delta));
                
                if (newScale !== scale) {
                    const rect = previewArea.getBoundingClientRect();
                    // Cursor position relative to center
                    const mx = e.clientX - rect.left - rect.width / 2;
                    const my = e.clientY - rect.top - rect.height / 2;
                    
                    // Adjust pan to keep cursor point fixed
                    pX -= (mx - pX) * (newScale / scale - 1);
                    pY -= (my - pY) * (newScale / scale - 1);

                    scale = newScale;
                    if (scale <= 1) { pX = 0; pY = 0; }
                    updateTransform();
                    showToolbar();
                }
            };

            // Pan Logic
            previewArea.onmousedown = (e) => {
                if (scale > 1 && e.button === 0) {
                    isDragging = true;
                    // Adjust for rotation? No, let's keep it simple: pan moves the image in screen space.
                    // If rotated, the image moves "weirdly" relative to its own axes but correctly relative to screen.
                    startX = e.clientX - pX;
                    startY = e.clientY - pY;
                    previewArea.style.cursor = 'grabbing';
                    e.preventDefault();
                }
            };
            
            document.addEventListener('mousemove', (e) => {
                if (isDragging && scale > 1) {
                    pX = e.clientX - startX;
                    pY = e.clientY - startY;
                    updateTransform();
                    showToolbar();
                } else if (self.isLoupeMode && previewArea.contains(e.target as Node)) {
                    // Show toolbar when hovering near bottom or over the toolbar itself
                    const rect = previewArea.getBoundingClientRect();
                    const isBottom = e.clientY > (rect.bottom - 80);
                    const isToolbar = zoomToolbar.contains(e.target as Node);
                    
                    if (isBottom || isToolbar) {
                        showToolbar();
                        // Keep it visible if hovering directly
                        if (isToolbar) {
                            zoomToolbar.style.opacity = '1';
                            if (zoomTimer) clearTimeout(zoomTimer);
                        }
                    }
                }
            });
            
            document.addEventListener('mouseup', () => { 
                if (isDragging) {
                    isDragging = false;
                    updateTransform();
                }
            });

            // Reset on load
            hub.sub(ps.PHOTO_SELECTED, (data) => {
                scale = 1; 
                rotation = self.rotationMap.get(data.id) || 0;
                pX = 0; pY = 0; isFullResLoaded = false;
                
                // Hide highres and apply rotation CSS BEFORE loading new src
                imgH.classList.remove('loaded');
                imgH.classList.toggle('is-portrait-rotated', rotation % 180 !== 0);
                imgP.classList.toggle('is-portrait-rotated', rotation % 180 !== 0);
                updateTransform(true, true); 
            });
            
            // Expose rotation handlers for keyboard
            self.rotateLeft = () => { rotation -= 90; triggerRotate(); };
            self.rotateRight = () => { rotation += 90; triggerRotate(); };

            const resizer = document.createElement('div');
            resizer.className = 'filmstrip-resizer';
            
            const filmstrip = document.createElement('div');
            filmstrip.id = 'filmstrip';
            filmstrip.className = 'filmstrip';
            (filmstrip.style as CSSStyleDeclaration & { scrollbarGutter: string }).scrollbarGutter = 'stable';
            
            loupeView.appendChild(previewArea);
            loupeView.appendChild(resizer);
            loupeView.appendChild(filmstrip);
            self.workspaceEl.appendChild(loupeView);

            container.getElement().append(self.workspaceEl);
            
            self.gridHeader = header;
            self.gridView = gridView;
            self.scrollSentinel = sentinel;
            self.loupeView = loupeView;
            self.filmstrip = filmstrip;
            self.gridViewManager.filmstripEl = filmstrip;
            self.loupePreviewPlaceholder = imgP as HTMLImageElement;
            self.mainPreview = imgH as HTMLImageElement;
            self.previewSpinner = spinner;

            gridContainer.onscroll = () => self.gridViewManager.update();
            
            // Filmstrip Resizer Logic
            let isResizing = false;
            resizer.onmousedown = (e) => { isResizing = true; e.preventDefault(); };
            document.addEventListener('mousemove', (e) => {
                if (!isResizing || !self.filmstrip) return;
                const offsetTop = self.loupeView!.getBoundingClientRect().top;
                const totalHeight = self.loupeView!.clientHeight;
                const newHeight = totalHeight - (e.clientY - offsetTop);
                if (newHeight > 100 && newHeight < 500) {
                    self.filmstrip.style.height = newHeight + 'px';
                    // Scale cards - we can adjust CSS variable or direct style
                    const cards = self.filmstrip.querySelectorAll('.card');
                    cards.forEach((c: any) => {
                        c.style.height = (newHeight - 30) + 'px';
                        c.style.width = ((newHeight - 30) * 1.33) + 'px';
                    });
                }
            });
            document.addEventListener('mouseup', () => { isResizing = false; });

            self.workspaceEl.tabIndex = 0;
            if (self.photos.length > 0) self.renderGrid();
        });
        this.layout.registerComponent('metadata', function(container: any) {
            self.metadataEl = document.createElement('div');
            self.metadataEl.className = 'metadata-panel gl-component';
            container.getElement().append(self.metadataEl);
        });
        this.layout.init();
        window.addEventListener('resize', () => { 
            this.layout.updateSize(); 
            if (this.libraryManager.libraryLayout) this.libraryManager.libraryLayout.updateSize();
            hub.pub(ps.UI_LAYOUT_CHANGED, {}); 
        });
        this.layout.on('stateChanged', () => hub.pub(ps.UI_LAYOUT_CHANGED, {}));
    }

    private updateSelectionUI(id: string) {
        const oldSel = this.workspaceEl?.querySelectorAll('.card.selected');
        oldSel?.forEach(e => e.classList.remove('selected'));
        const newSel = this.workspaceEl?.querySelectorAll(`.card[data-id="${id}"]`);
        newSel?.forEach(e => e.classList.add('selected'));
        if (this.isLoupeMode) {
            const stripItem = this.filmstrip?.querySelector(`.card[data-id="${id}"]`);
            if (stripItem) stripItem.scrollIntoView({ behavior: 'smooth', inline: 'center' });
        }
    }

    private ensureSelectedFolderVisible() {
        if (!this.selectedRootId) return;
        
        let changed = false;
        let currentId: string | undefined = this.selectedRootId;

        // Expand the selected folder itself
        if (!this.expandedFolders.has(currentId)) {
            this.expandedFolders.add(currentId);
            changed = true;
        }

        // Trace up and expand ancestors
        while (currentId) {
            const node = this.roots.find(r => r.id === currentId);
            if (node && node.parentId) {
                if (!this.expandedFolders.has(node.parentId)) {
                    this.expandedFolders.add(node.parentId);
                    changed = true;
                }
                currentId = node.parentId;
            } else {
                break;
            }
        }

        if (changed) {
            Api.api_settings_set({ 
                key: 'folder-expanded-state', 
                value: JSON.stringify(Array.from(this.expandedFolders)) 
            });
        }
    }

    renderLibrary() {
        if (!this.libraryEl) return;
        this.ensureSelectedFolderVisible();
        this.libraryEl.innerHTML = '';
        const createSection = (title: string) => {
            const el = document.createElement('div');
            el.className = 'tree-section-header';
            el.textContent = title;
            return el;
        };
        this.libraryEl.appendChild(createSection('Search'));
        const searchBox = document.createElement('div');
        searchBox.className = 'search-box';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'search-input';
        searchInput.placeholder = 'Search by filename...';
        searchInput.onkeydown = (e) => { if (e.key === 'Enter') hub.pub(ps.SEARCH_TRIGGERED, { tag: 'FileName', value: searchInput.value }); };
        
        const searchSpinner = document.createElement('div');
        searchSpinner.className = 'search-loading';
        
        searchBox.appendChild(searchInput);
        searchBox.appendChild(searchSpinner);
        this.libraryEl.appendChild(searchBox);
        if (this.filterType === 'search') this.addTreeItem(this.libraryEl, '\uD83D\uDD0D ' + this.searchTitle, this.searchResultIds.length, () => this.setFilter('search'), true, 'search');
        this.libraryEl.appendChild(createSection('Collections'));
        this.addTreeItem(this.libraryEl, 'All Photos', this.stats.totalCount, () => this.setFilter('all'), this.filterType === 'all' && !this.selectedRootId, 'all');
        
        const pEl = this.addTreeItem(this.libraryEl, '\u2691 Picked', this.stats.pickedCount, () => this.setFilter('picked'), this.filterType === 'picked', 'picked');
        pEl.oncontextmenu = (e) => { e.preventDefault(); this.showPickedContextMenu(e); };
        
        this.userCollections.forEach(c => {
            const el = this.addTreeItem(this.libraryEl!, '\uD83D\uDCC1 ' + c.name, c.count, () => this.setCollectionFilter(c), this.selectedCollectionId === c.id, 'collection-' + c.id);
            el.oncontextmenu = (e) => { e.preventDefault(); this.showCollectionContextMenu(e, c); };
        });
        for (let i = 5; i >= 1; i--) {
            const count = this.stats.ratingCounts[i-1];
            this.addTreeItem(this.libraryEl, '\u2605'.repeat(i), count, () => this.setFilter('rating', i), this.filterType === 'rating' && this.filterRating === i, 'rating-' + i);
        }
        this.libraryEl.appendChild(createSection('Folders'));
        const treeContainer = document.createElement('div');
        treeContainer.className = 'tree-folder-root';
        this.libraryEl.appendChild(treeContainer);
        
        this.renderFolderTree(treeContainer);
    }

    private updateFolderProgressUI(rootId: string, container?: HTMLElement) {
        const prog = this.folderProgress.get(rootId);
        const el = container || document.getElementById(`folder-prog-${rootId}`);
        if (!el) return;

        if (!prog || prog.total === 0) {
            el.innerHTML = '';
            return;
        }

        const total = prog.total;
        const thumbnailed = prog.thumbnailed !== undefined ? prog.thumbnailed : prog.processed;
        
        // Disappear if 100%
        if (thumbnailed >= total) {
            el.innerHTML = '';
            return;
        }

        const notThumbnailed = total - thumbnailed;
        
        // Formula: (thumbnailed - notthumbnailed) / total
        const rawPercent = ((thumbnailed - notThumbnailed) / total) * 100;
        const displayPercent = Math.max(0, Math.round(rawPercent));

        el.innerHTML = `
            <div style="width: 60px; height: 8px; background: var(--bg-input); border: 1px solid var(--border-light); border-radius: 4px; overflow: hidden; margin: 0 0.5em; position: relative;" title="Thumbnailed: ${thumbnailed}, Remaining: ${notThumbnailed}, Total: ${total}">
                <div style="width: ${displayPercent}%; height: 100%; background: var(--accent); transition: width 0.2s ease;"></div>
            </div>
            <span class="cancel-task" style="cursor: pointer; padding: 0 4px; color: var(--text-muted); font-size: 1.2em; line-height: 1;" title="Cancel">&times;</span>
        `;
        
        el.querySelector('.cancel-task')?.addEventListener('click', (e) => {
            e.stopPropagation();
            Api.api_library_cancel_task({ id: `thumbnails-${rootId}` });
        });
    }

    private getContrastColor(hexcolor: string): string {
        // If no color provided, default to white text
        if (!hexcolor) return '#ffffff';
        
        // Remove # if present
        const hex = hexcolor.replace('#', '');
        
        // Convert to RGB
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);
        
        // Calculate YIQ brightness
        const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
        
        // Return black or white based on brightness
        return (yiq >= 128) ? '#000000' : '#ffffff';
    }

    private renderFolderTree(container: HTMLElement) {
        const map = new Map<string, FolderTreeNode>();
        this.roots.forEach(r => map.set(r.id, { node: r, children: [] }));
        
        const roots: FolderTreeNode[] = [];
        this.roots.forEach(r => { 
            if (r.parentId && map.has(r.parentId)) map.get(r.parentId)!.children.push(map.get(r.id)!); 
            else roots.push(map.get(r.id)!); 
        });

        this.flatFolderList = [];

        const saveExpansionState = () => {
            Api.api_settings_set({ 
                key: 'folder-expanded-state', 
                value: JSON.stringify(Array.from(this.expandedFolders)) 
            });
        };

        const renderNode = (item: FolderTreeNode, target: HTMLElement) => {
            this.flatFolderList.push(item.node.id);
            const el = document.createElement('div');
            el.className = 'tree-item' + (this.selectedRootId === item.node.id ? ' selected' : '');
            el.id = `folder-item-${item.node.id}`;
            
            const pill = document.createElement('span');
            pill.className = 'annotation-pill' + (item.node.annotation ? ' has-content' : '');
            pill.contentEditable = 'true';
            pill.textContent = item.node.annotation || '';
            if (item.node.color) {
                pill.style.backgroundColor = item.node.color;
                pill.style.color = this.getContrastColor(item.node.color);
            }
            
            const saveAnnotation = async (color?: string) => {
                const raw = pill.textContent || '';
                const words = raw.trim().split(/\s+/).slice(0, 3).join(' ');
                const targetColor = color || item.node.color;
                if (words !== (item.node.annotation || '') || color) {
                    await Api.api_library_set_annotation({ folderId: item.node.id, annotation: words, color: targetColor || undefined });
                    item.node.annotation = words;
                    if (targetColor) {
                        item.node.color = targetColor;
                        pill.style.backgroundColor = targetColor;
                        pill.style.color = this.getContrastColor(targetColor);
                    }
                }
                pill.textContent = words;
                pill.classList.toggle('has-content', !!words);
            };

            pill.onblur = () => saveAnnotation();
            pill.onfocus = () => {
                pill.classList.add('has-content'); // Ensure visible during edit
            };
            pill.onclick = (e) => e.stopPropagation();
            pill.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'color';
                input.value = item.node.color || '#00bcd4'; // Default accent
                input.oninput = () => {
                    pill.style.backgroundColor = input.value;
                    pill.style.color = this.getContrastColor(input.value);
                };
                input.onchange = () => {
                    saveAnnotation(input.value);
                };
                input.click();
            };
            pill.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    pill.blur();
                }
            };

            const annotationIcon = document.createElement('span');
            annotationIcon.className = 'annotation-icon';
            annotationIcon.innerHTML = '&#128172;'; 
            annotationIcon.title = 'Add/Edit Annotation';
            annotationIcon.onclick = (e) => {
                e.stopPropagation();
                pill.classList.add('has-content');
                pill.focus();
            };

            const isExpanded = this.expandedFolders.has(item.node.id);
            const toggle = document.createElement('span');
            toggle.style.width = '1.2em';
            toggle.style.display = 'inline-block';
            toggle.style.textAlign = 'center';
            toggle.style.cursor = 'pointer';
            toggle.innerHTML = item.children.length > 0 ? (isExpanded ? '&#9662;' : '&#9656;') : '&nbsp;';

            el.appendChild(annotationIcon);
            el.appendChild(pill);
            el.appendChild(toggle);

            const name = document.createElement('span');
            name.className = 'tree-name';
            name.style.flex = '1';
            name.style.overflow = 'hidden';
            name.style.textOverflow = 'ellipsis';
            name.textContent = item.node.name!;

            const progContainer = document.createElement('div');
            progContainer.id = `folder-prog-${item.node.id}`;
            progContainer.style.display = 'flex';
            progContainer.style.alignItems = 'center';

            el.appendChild(toggle);
            el.appendChild(name);
            el.appendChild(progContainer);

            // Initial render of progress if active
            if (this.folderProgress.has(item.node.id)) {
                this.updateFolderProgressUI(item.node.id, progContainer);
            }

            const count = document.createElement('span');
            count.className = 'count';
            count.textContent = item.node.imageCount > 0 ? item.node.imageCount.toString() : '';
            el.appendChild(count);

            target.appendChild(el);

            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'tree-children';
            childrenContainer.style.paddingLeft = '1em';
            childrenContainer.style.display = isExpanded ? 'block' : 'none';
            target.appendChild(childrenContainer);

            el.onclick = () => this.setFilter('all', 0, item.node.id);
            el.oncontextmenu = (e) => {
                e.preventDefault();
                this.showFolderContextMenu(e, item.node.id);
            };

            if (this.selectedRootId === item.node.id) {
                setTimeout(() => el.scrollIntoView({ behavior: 'auto', block: 'nearest' }), 50);
            }

            if (item.children.length > 0) {
                toggle.onclick = (e) => {
                    e.stopPropagation();
                    const nowExpanded = childrenContainer.style.display === 'none';
                    if (nowExpanded) {
                        childrenContainer.style.display = 'block';
                        toggle.innerHTML = '&#9662;';
                        this.expandedFolders.add(item.node.id);
                    } else {
                        childrenContainer.style.display = 'none';
                        toggle.innerHTML = '&#9656;';
                        this.expandedFolders.delete(item.node.id);
                    }
                    saveExpansionState();
                };

                item.children.forEach((c: FolderTreeNode) => renderNode(c, childrenContainer));
            }
        };

        roots.forEach(r => renderNode(r, container));
    }

    addTreeItem(container: HTMLElement, text: string, count: number, onClick: () => void, isSelected: boolean, typeAttr: string) {
        const el = document.createElement('div');
        el.className = 'tree-item' + (isSelected ? ' selected' : '');
        el.dataset.type = typeAttr;
        const s = document.createElement('span'); s.textContent = text;
        const c = document.createElement('span'); c.className = 'count'; c.textContent = count > 0 ? count.toString() : '';
        el.appendChild(s); el.appendChild(c);
        el.onclick = onClick;
        container.appendChild(el);
        return el;
    }

    setFilter(type: 'all' | 'picked' | 'rating' | 'search', rating: number = 0, rootId: string | null = null) {
        this.prioritySession++;
        this.filterType = type;
        this.filterRating = rating;
        this.selectedRootId = rootId;
        this.selectedCollectionId = null;
        this.refreshPhotos();
        this.syncUrl();
    }

    async setCollectionFilter(c: Collection) {
        this.prioritySession++;
        this.filterType = 'collection';
        this.selectedCollectionId = c.id;
        this.selectedRootId = null;
        this.collectionFiles = await Api.api_collections_get_files({ id: c.id });
        this.refreshPhotos();
        this.syncUrl();
    }

    setupContextMenu() { document.addEventListener('click', () => { const menu = document.getElementById('context-menu'); if (menu) menu.style.display = 'none'; }); }

    showFolderContextMenu(e: MouseEvent, rootId: string) {
        console.log(`[App] showFolderContextMenu for ${rootId}`);
        const menu = document.getElementById('context-menu')!;
        menu.innerHTML = '';
        const addItem = (text: string, cb: () => void) => {
            const el = document.createElement('div'); 
            el.className = 'context-menu-item'; 
            el.textContent = text; 
            el.onclick = (e) => { 
                e.stopPropagation(); 
                cb(); 
                menu.style.display = 'none'; 
            }; 
            menu.appendChild(el);
        };

        addItem('Generate Thumbnails (This Folder)', () => {
            Api.api_library_generate_thumbnails({ rootId, recursive: false })
                .catch(err => {
                    console.error('Failed to start thumbnail generation', err);
                    this.showNotification('Failed to start thumbnail generation', 'error');
                });
            this.showNotification('Thumbnail generation started', 'info');
        });
        addItem('Generate Thumbnails (Recursive)', () => {
            Api.api_library_generate_thumbnails({ rootId, recursive: true })
                .catch(err => {
                    console.error('Failed to start recursive thumbnail generation', err);
                    this.showNotification('Failed to start recursive thumbnail generation', 'error');
                });
            this.showNotification('Recursive thumbnail generation started', 'info');
        });

        menu.style.display = 'block';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
    }

    showPhotoContextMenu(e: MouseEvent, p: Photo) {
        const menu = document.getElementById('context-menu')!;
        menu.innerHTML = '';
        const addItem = (text: string, cb: () => void) => {
            const el = document.createElement('div'); el.className = 'context-menu-item'; el.textContent = text; el.onclick = (e) => { e.stopPropagation(); cb(); menu.style.display = 'none'; }; menu.appendChild(el);
        };

        addItem('Add to New Collection...', () => this.storePickedToCollection(null, [p.id]));
        
        if (this.userCollections.length > 0) {
            const d = document.createElement('div'); d.className = 'context-menu-divider'; menu.appendChild(d);
            this.userCollections.forEach(c => {
                addItem(`Add to '${c.name}'`, () => {
                    Api.api_collections_add_files({ collectionId: c.id, fileIds: [p.id] });
                    this.showNotification(`Added to ${c.name}`, 'success');
                    this.refreshCollections();
                });
            });
        }

        const d2 = document.createElement('div'); d2.className = 'context-menu-divider'; menu.appendChild(d2);
        addItem('Force Update Preview', () => {
            Api.api_library_force_update_preview({ id: p.id });
            this.showNotification('Preview regeneration requested', 'info');
        });

        menu.style.display = 'block';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
    }

    showPickedContextMenu(e: MouseEvent) {
        const menu = document.getElementById('context-menu')!;
        menu.innerHTML = '';
        const addItem = (text: string, cb: () => void) => {
            const el = document.createElement('div'); el.className = 'context-menu-item'; el.textContent = text; el.onclick = cb; menu.appendChild(el);
        };
        addItem('Clear All Picked', () => this.clearAllPicked());
        const d = document.createElement('div'); d.className = 'context-menu-divider'; menu.appendChild(d);
        addItem('Store to new collection...', () => this.storePickedToCollection(null));
        this.userCollections.forEach(c => addItem(`Store to '${c.name}'`, () => this.storePickedToCollection(c.id)));
        
        const d2 = document.createElement('div'); d2.className = 'context-menu-divider'; menu.appendChild(d2);
        addItem('Download ZIP (Previews)', () => this.downloadZip('previews'));
        addItem('Download ZIP (Originals)', () => this.downloadZip('originals'));

        menu.style.display = 'block'; menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px';
    }

    showCollectionContextMenu(e: MouseEvent, c: Collection) {
        const menu = document.getElementById('context-menu')!;
        menu.innerHTML = '';
        const addItem = (text: string, cb: () => void) => {
            const el = document.createElement('div'); el.className = 'context-menu-item'; el.textContent = text; el.onclick = cb; menu.appendChild(el);
        };
        addItem('Remove Collection', () => this.deleteCollection(c.id));
        const d = document.createElement('div'); d.className = 'context-menu-divider'; menu.appendChild(d);
        addItem('Download ZIP (Previews)', () => this.downloadZip('previews', c.id));
        addItem('Download ZIP (Originals)', () => this.downloadZip('originals', c.id));

        menu.style.display = 'block'; menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px';
    }

    private async downloadZip(type: 'previews' | 'originals', collectionId?: string) {
        hub.pub(ps.UI_NOTIFICATION, { message: 'Preparing download...', type: 'info' });
        
        let fileIds: string[] = [];
        let exportName = 'picked';

        if (collectionId) {
            const coll = this.userCollections.find(c => c.id === collectionId);
            exportName = coll?.name || 'collection';
            fileIds = await Api.api_collections_get_files({ id: collectionId });
        } else if (this.filterType === 'picked') {
            fileIds = await Api.api_picked_ids({});
        }

        if (fileIds.length === 0) return;

        if (this.stackingEnabled) {
            const reps = this.photos.filter(p => fileIds.includes(p.id));
            fileIds = reps.map(r => r.id);
        }

        try {
            // 1. Get token
            const prep = await fetch('/api/export/prepare', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileIds, type, name: exportName })
            });

            if (prep.ok) {
                const { token } = await prep.json();
                // 2. Trigger native browser download stream
                window.location.href = `/api/export/download?token=${token}`;
                hub.pub(ps.UI_NOTIFICATION, { message: 'Download started', type: 'success' });
            } else {
                hub.pub(ps.UI_NOTIFICATION, { message: 'Failed to prepare export', type: 'error' });
            }
        } catch (e) {
            console.error(e);
            hub.pub(ps.UI_NOTIFICATION, { message: 'Error starting download', type: 'error' });
        }
    }

    async clearAllPicked() { await Api.api_picked_clear({}); this.refreshPhotos(); hub.pub(ps.UI_NOTIFICATION, { message: 'Picked photos cleared', type: 'info' }); }

    async storePickedToCollection(id: string | null, specificIds?: string[]) {
        const fileIds = specificIds || await Api.api_picked_ids({});
        if (fileIds.length === 0) return;
        let name = '';
        if (id === null) {
            name = prompt('New Collection Name:') || '';
            if (!name) return;
            const res = await Api.api_collections_create({ name });
            id = res.id;
        } else {
            const coll = this.userCollections.find(c => c.id === id);
            name = coll?.name || 'Collection';
        }
        await Api.api_collections_add_files({ collectionId: id!, fileIds: fileIds });
        this.showNotification(`Collection ${name} updated`, 'success');
        await this.refreshCollections();
    }

    async deleteCollection(id: string) {
        const coll = this.userCollections.find(c => c.id === id);
        const name = coll?.name || 'Collection';
        if (!confirm(`Are you sure you want to remove collection '${name}'?`)) return;
        await Api.api_collections_delete({ id });
        this.showNotification(`Collection ${name} deleted`, 'info');
        if (this.selectedCollectionId === id) this.setFilter('all');
        else await this.refreshCollections();
    }

    async refreshCollections() { this.userCollections = await Api.api_collections_list({}); this.renderLibrary(); }

    async searchPhotos(tag: string, value: string) {
        const spinner = document.querySelector('.search-loading');
        if (spinner) spinner.classList.add('active');
        
        try {
            this.searchResultIds = await Api.api_search({ tag, value });
            this.searchTitle = `${tag}: ${value}`;
            this.setFilter('search');
        } finally {
            if (spinner) spinner.classList.remove('active');
        }
    }

    public getFilteredPhotos(): Photo[] { return this.photos; }

    renderGrid() {
        this.gridViewManager.update(true);
        let headerText = "All Photos";
        if (this.filterType === 'picked') headerText = "Collection: Picked";
        else if (this.filterType === 'rating') headerText = "Collection: Starred";
        else if (this.filterType === 'search') headerText = "Search: " + this.searchTitle;
        else if (this.filterType === 'collection') { const c = this.userCollections.find(x => x.id === this.selectedCollectionId); headerText = "Collection: " + (c?.name || ""); }
        else if (this.selectedRootId) { const root = this.roots.find(r => r.id === this.selectedRootId); headerText = root ? `Folder: ${root.name}` : "Folder"; }
        if (this.gridHeader) {
            const headerTextEl = this.gridHeader.querySelector('#header-text');
            if (headerTextEl) {
                headerTextEl.innerHTML = '';
                headerTextEl.appendChild(document.createTextNode('Showing '));
                const b = document.createElement('b'); b.textContent = headerText;
                headerTextEl.appendChild(b);
            }
            const headerCountEl = this.gridHeader.querySelector('#header-count');
            if (headerCountEl) headerCountEl.textContent = `${this.totalPhotos} items`;
        }
    }

    renderFilmstrip() {
        if (!this.filmstrip) return;
        this.filmstrip.innerHTML = '';
        const loadedPhotos = this.getFilteredPhotos();
        loadedPhotos.forEach(p => this.filmstrip!.appendChild(this.gridViewManager.createCard(p, 'filmstrip')));
        if (this.selectedId) {
            const el = this.filmstrip.querySelector(`.card[data-id="${this.selectedId}"]`);
            if (el) el.scrollIntoView({ behavior: 'auto', inline: 'center' });
        }
    }

    selectPhoto(id: string) {
        if (this.selectedId === id) return;
        this.selectedId = id;
        this.updateSelectionUI(id);
        this.loadMetadata(id);
        if (this.isFullscreen) this.updateFullscreenImage(id);
        else if (this.isLoupeMode) this.loadMainPreview(id);
    }

    enterLoupeMode(id: string) {
        this.prioritySession++;
        this.isLoupeMode = true;
        this.isLibraryMode = false;
        this.updateViewModeUI();
        this.selectPhoto(id);
        this.loadMainPreview(id);
    }

    enterGridMode() {
        this.isLoupeMode = false;
        this.isLibraryMode = false;
        this.updateViewModeUI();
        if (this.selectedId) this.gridViewManager.scrollToPhoto(this.selectedId);
        this.gridViewManager.update(true);
        this.syncUrl();
    }

    enterLibraryMode() {
        this.isLoupeMode = false;
        this.isLibraryMode = true;
        this.updateViewModeUI();
        if (!this.libraryManager.libraryLayout) {
            this.libraryManager.initLayout('library-view', () => {
                this.isIndexing = true;
                this.libraryManager.triggerScan(this.showNotification.bind(this));
            });
        }
        this.libraryManager.loadLibraryInfo();
        this.syncUrl();
    }

    private updateViewModeUI() {
        const layoutCont = document.getElementById('layout-container')!;
        const libraryView = document.getElementById('library-view')!;
        
        document.querySelectorAll('.lr-nav-item').forEach(el => el.classList.remove('active'));

        if (this.isLibraryMode) {
            layoutCont.style.display = 'none';
            libraryView.style.display = 'block';
            document.getElementById('nav-library')?.classList.add('active');
        } else {
            layoutCont.style.display = 'block';
            libraryView.style.display = 'none';
            
            const gridCont = (this.workspaceEl?.querySelector('#grid-container') as HTMLElement);
            if (this.isLoupeMode) {
                if (gridCont) gridCont.style.display = 'none';
                if (this.gridHeader) this.gridHeader.style.display = 'none';
                if (this.loupeView) this.loupeView.style.display = 'flex';
                document.getElementById('nav-loupe')?.classList.add('active');
                this.renderFilmstrip();
            } else {
                if (this.loupeView) this.loupeView.style.display = 'none';
                if (gridCont) gridCont.style.display = 'flex';
                if (this.gridHeader) this.gridHeader.style.display = 'flex';
                document.getElementById('nav-grid')?.classList.add('active');
                this.gridViewManager.update(true);
            }
        }
    }

    loadMainPreview(id: string) {
        if (!this.mainPreview || !this.loupePreviewPlaceholder || !this.previewSpinner) return;
        
        this.mainPreview.classList.remove('loaded');
        this.mainPreview.src = ''; // Clear to prevent showing old image with new rotation
        this.loupePreviewPlaceholder.style.display = 'none';
        this.loupePreviewPlaceholder.src = '';
        this.previewSpinner.style.display = 'block';
        
        const lowResKey = id + '-300';
        const highResKey = id + '-1024';

        const requestHighRes = () => {
            // console.log(`[Loupe] Requesting high-res for ${id}`);
            const priority = this.getPriority?.(id) || (this.prioritySession + 2); // Boost loupe priority
            server.requestImage(id, 1024, priority).then((blob: Blob) => {
                if (this.selectedId === id && this.isLoupeMode) {
                    const url = URL.createObjectURL(blob);
                    this.imageUrlCache.set(highResKey, url);
                    this.mainPreview!.src = url;
                    this.mainPreview!.onload = () => {
                        if (this.selectedId === id) {
                            this.mainPreview!.classList.add('loaded');
                            this.previewSpinner!.style.display = 'none';
                        }
                    };
                    this.mainPreview!.onerror = () => {
                        console.error(`[Loupe] High-res load error for ${id}`);
                        if (this.selectedId === id) this.previewSpinner!.style.display = 'none';
                    };
                }
            }).catch(e => {
                console.error(`[Loupe] High-res request failed for ${id}`, e);
                if (this.selectedId === id) this.previewSpinner!.style.display = 'none';
            });
        };

        if (this.imageUrlCache.has(highResKey)) {
            // console.log(`[Loupe] High-res cache hit for ${id}`);
            this.mainPreview.src = this.imageUrlCache.get(highResKey)!;
            this.mainPreview.classList.add('loaded');
            this.previewSpinner.style.display = 'none';
            this.loupePreviewPlaceholder.style.display = 'none';
            return;
        }

        if (this.imageUrlCache.has(lowResKey)) {
            // console.log(`[Loupe] Low-res cache hit for ${id}`);
            this.loupePreviewPlaceholder.src = this.imageUrlCache.get(lowResKey)!;
            this.loupePreviewPlaceholder.style.display = 'block';
            requestHighRes();
        } else {
            this.loupePreviewPlaceholder.style.display = 'none';
            // console.log(`[Loupe] Requesting low-res for ${id}`);
            const priority = this.getPriority?.(id) || (this.prioritySession + 2);
            server.requestImage(id, 300, priority).then((blob: Blob) => {
                const url = URL.createObjectURL(blob);
                this.imageUrlCache.set(lowResKey, url);
                if (this.selectedId === id && this.isLoupeMode) {
                    this.loupePreviewPlaceholder!.src = url;
                    this.loupePreviewPlaceholder!.style.display = 'block';
                    requestHighRes();
                }
            }).catch(e => {
                console.error(`[Loupe] Low-res request failed for ${id}`, e);
                requestHighRes(); // Try high-res anyway?
            });
        }
    }

    private updateFullscreenImage(id: string) {
        if (!this.fullscreenImgPlaceholder || !this.fullscreenImgHighRes || !this.fullscreenSpinner || !this.fullscreenOverlay) return;
        
        this.fullscreenImgHighRes.classList.remove('loaded');
        this.fullscreenImgHighRes.src = '';
        this.fullscreenImgPlaceholder.style.display = 'none';
        this.fullscreenImgPlaceholder.src = '';
        this.fullscreenSpinner.style.display = 'block';
        
        const rot = this.rotationMap.get(id) || 0;
        this.fullscreenImgHighRes.style.transform = `rotate(${rot}deg)`;
        this.fullscreenImgPlaceholder.style.transform = `rotate(${rot}deg)`;

        const dlOrig = this.fullscreenOverlay.querySelector('.fullscreen-btn:nth-child(2)') as HTMLAnchorElement;
        if (dlOrig) dlOrig.href = `/api/download/${id}`;

        const dlJpg = this.fullscreenOverlay.querySelector('.fullscreen-btn:nth-child(1)') as HTMLAnchorElement;
        if (dlJpg) dlJpg.removeAttribute('href');

        const lowResKey = id + '-1024';
        const thumbKey = id + '-300';
        const highResKey = id + '-0';
        
        const requestFullRes = () => {
            if (this.imageUrlCache.has(highResKey)) {
                const url = this.imageUrlCache.get(highResKey)!;
                this.fullscreenImgHighRes!.src = url;
                
                const photo = this.photoMap.get(id);
                if (dlJpg && photo) {
                    dlJpg.href = url;
                    dlJpg.download = (photo.fileName || 'render').split('.')[0] + '_render.jpg';
                }

                if (this.fullscreenImgHighRes!.complete) {
                    this.fullscreenImgHighRes!.classList.add('loaded');
                    this.fullscreenSpinner!.style.display = 'none';
                } else {
                    this.fullscreenImgHighRes!.onload = () => {
                        if (this.selectedId === id) {
                            this.fullscreenImgHighRes!.classList.add('loaded');
                            this.fullscreenSpinner!.style.display = 'none';
                        }
                    };
                }
                return;
            }

            server.requestImage(id, 0).then((blob: Blob) => {
                if (this.selectedId === id && this.isFullscreen) {
                    if (blob.size === 0) {
                        // Error fallback: just stop spinner
                        this.fullscreenSpinner!.style.display = 'none';
                        return;
                    }

                    const url = URL.createObjectURL(blob);
                    this.imageUrlCache.set(highResKey, url);
                    this.fullscreenImgHighRes!.src = url;
                    
                    const photo = this.photoMap.get(id);
                    if (dlJpg && photo) {
                        dlJpg.href = url;
                        dlJpg.download = (photo.fileName || 'render').split('.')[0] + '_render.jpg';
                    }

                    this.fullscreenImgHighRes!.onload = () => {
                        if (this.selectedId === id) {
                            this.fullscreenImgHighRes!.classList.add('loaded');
                            this.fullscreenSpinner!.style.display = 'none';
                        }
                    };
                }
            });
        };

        // UI Strategy: Use the largest available cached image as placeholder
        let bestUrl: string | null = null;
        if (this.imageUrlCache.has(lowResKey)) bestUrl = this.imageUrlCache.get(lowResKey)!;
        else if (this.imageUrlCache.has(thumbKey)) bestUrl = this.imageUrlCache.get(thumbKey)!;

        if (bestUrl) {
            this.fullscreenImgPlaceholder.src = bestUrl;
            this.fullscreenImgPlaceholder.style.display = 'block';
        } else {
            this.fullscreenImgPlaceholder.style.display = 'none';
        }
        
        requestFullRes();
    }

    private toggleFullscreen() {
        if (this.isFullscreen) {
            this.fullscreenOverlay?.remove();
            this.fullscreenOverlay = null;
            this.fullscreenImgPlaceholder = null;
            this.fullscreenImgHighRes = null;
            this.fullscreenSpinner = null;
            this.isFullscreen = false;
            
            // Refresh loupe if we are returning to it
            if (this.isLoupeMode && this.selectedId) {
                this.loadMainPreview(this.selectedId);
                this.updateLoupeOverlay(this.selectedId);
            }
            return;
        }

        if (!this.selectedId) return;
        
        this.isFullscreen = true;
        const overlay = document.createElement('div');
        overlay.className = 'fullscreen-overlay';
        
        const spinner = document.createElement('div'); spinner.className = 'spinner'; 
        overlay.appendChild(spinner);
        this.fullscreenSpinner = spinner;

        const imgP = document.createElement('img'); 
        imgP.className = 'fullscreen-img placeholder';
        overlay.appendChild(imgP);
        this.fullscreenImgPlaceholder = imgP;

        const imgH = document.createElement('img');
        imgH.className = 'fullscreen-img highres';
        overlay.appendChild(imgH);
        this.fullscreenImgHighRes = imgH;
        
        document.body.appendChild(overlay);
        this.fullscreenOverlay = overlay;
        
        const closeBtn = document.createElement('div');
        closeBtn.className = 'fullscreen-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = (e) => { e.stopPropagation(); this.toggleFullscreen(); };
        overlay.appendChild(closeBtn);

        const actions = document.createElement('div');
        actions.className = 'fullscreen-actions';
        
        const dlJpg = document.createElement('a');
        dlJpg.className = 'fullscreen-btn';
        dlJpg.title = 'Download High-Res JPG Render';
        dlJpg.textContent = 'JPG';
        dlJpg.onclick = (e) => e.stopPropagation();
        
        const dlOrig = document.createElement('a');
        dlOrig.className = 'fullscreen-btn';
        dlOrig.title = 'Download Original Source File';
        dlOrig.textContent = 'ORIG';
        dlOrig.onclick = (e) => e.stopPropagation();

        actions.appendChild(dlJpg);
        actions.appendChild(dlOrig);
        overlay.appendChild(actions);

        overlay.onclick = () => this.toggleFullscreen();
        this.updateFullscreenImage(this.selectedId);
    }

    async loadMetadata(id: string) {
        if (!this.metadataEl || !id) return;
        const photo = this.photoMap.get(id);
        if (!photo) return;

        const priorityTags = ['Exposure Time', 'Shutter Speed Value', 'F-Number', 'Aperture Value', 'Max Aperture Value', 'ISO Speed Rating', 'ISO', 'Focal Length', 'Focal Length 35', 'Lens Model', 'Lens', 'Model', 'Make', 'Exposure Bias Value', 'Exposure Mode', 'Exposure Program', 'Focus Mode', 'Image Stabilisation', 'Metering Mode', 'White Balance', 'Flash', 'Color Temperature', 'Quality', 'Created', 'Size', 'Image Width', 'Image Height', 'Exif Image Width', 'Exif Image Height', 'Software', 'Orientation', 'ID'];
        const groupOrder = ['File Info', 'Exif SubIF', 'Exif IFD0', 'Sony Maker', 'GPS', 'XMP'];

        try {
            const meta = await Api.api_metadata({ id });
            this.selectedMetadata = meta;
            if (this.isLoupeMode) this.updateLoupeOverlay(id);

            // Update hash if provided (lazy computed)
            const hashItem = meta.find(m => m.tag === 'FileHash');
            if (hashItem && hashItem.value) {
                const p = this.photoMap.get(id);
                if (p) p.hash = hashItem.value;
            }

            // Restore View Preferences
            const viewPref = meta.find(m => m.tag === 'ViewPreferences');
            if (viewPref && viewPref.value && this.isLoupeMode && this.setViewTransform) {
                try {
                    const p = JSON.parse(viewPref.value);
                    this.setViewTransform(p.rotation, p.zoom, p.panL, p.panT);
                } catch (e) { console.error('Failed to restore view prefs', e); }
            }

            const groups: { [k: string]: MetadataItem[] } = {};
            meta.forEach(m => { const k = m.directory || 'Unknown'; if (!groups[k]) groups[k] = []; groups[k].push(m); });
            groups['File Info'] = [
                { directory: 'File Info', tag: 'Created', value: new Date(photo.createdAt).toLocaleString() },
                { directory: 'File Info', tag: 'Size', value: (photo.size / (1024 * 1024)).toFixed(2) + ' MB' },
                { directory: 'File Info', tag: 'ID', value: id }
            ];

            const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
                const getMinPriority = (g: string) => { const priorities = groups[g].map(i => priorityTags.indexOf(i.tag!)).filter(p => p !== -1); return priorities.length > 0 ? Math.min(...priorities) : 999; };
                const pa = getMinPriority(a); const pb = getMinPriority(b);
                if (pa !== pb) return pa - pb;
                let ia = groupOrder.indexOf(a); let ib = groupOrder.indexOf(b);
                if (ia === -1) ia = 999; if (ib === -1) ib = 999;
                return ia - ib;
            });

            if (!this.metaTitleEl) {
                this.metaTitleEl = document.createElement('h2');
                this.metadataEl.appendChild(this.metaTitleEl);
            }
            const pickText = photo.isPicked ? '\u2691' : '';
            const starsText = photo.rating > 0 ? '\u2605'.repeat(photo.rating) : '';
            this.metaTitleEl.textContent = `${photo.fileName} ${pickText} ${starsText}`;

            if (!this.metaVisEl) {
                this.metaVisEl = document.createElement('div');
                this.metaVisEl.id = 'meta-vis-container';
                this.metaVisEl.style.marginBottom = '1em';
                this.metaTitleEl.after(this.metaVisEl);
            }

            // Camera Thumbnail & Visualization
            const modelItem = meta.find(m => m.tag === 'Model' || m.tag === 'Camera Model Name');
            const model = modelItem?.value || '';
            
            const renderVis = (thumbUrl?: string) => {
                const hasAperture = meta.some(m => m.tag === 'F-Number' || m.tag === 'Aperture Value');
                const hasFocal = meta.some(m => m.tag === 'Focal Length');
                if (hasAperture && hasFocal) {
                    this.metaVisEl!.style.display = 'block';
                    visualizeLensData(meta as Parameters<typeof visualizeLensData>[0], 'meta-vis-container', thumbUrl);
                } else {
                    this.metaVisEl!.style.display = 'none';
                }
            };

            if (model) {
                if (this.cameraThumbCache.has(model)) {
                    renderVis(this.cameraThumbCache.get(model));
                } else {
                    const thumbUrl = `/api/camera/thumbnail/${encodeURIComponent(model)}`;
                    const img = new Image();
                    img.onload = () => {
                        this.cameraThumbCache.set(model, thumbUrl);
                        renderVis(thumbUrl);
                    };
                    img.onerror = () => {
                        this.cameraThumbCache.set(model, '');
                        renderVis();
                    };
                    img.src = thumbUrl;
                }
            } else {
                renderVis();
            }

            const seenGroups = new Set<string>();

            for (const k of sortedGroupKeys) {
                seenGroups.add(k);
                let groupInfo = this.metaGroups.get(k);
                if (!groupInfo) {
                    const container = document.createElement('div');
                    container.className = 'meta-group';
                    const h3 = document.createElement('h3');
                    h3.textContent = k;
                    container.appendChild(h3);
                    this.metadataEl.appendChild(container);
                    groupInfo = { container, rows: new Map() };
                    this.metaGroups.set(k, groupInfo);
                }

                const items = groups[k];
                items.sort((a, b) => { let ia = priorityTags.indexOf(a.tag!); let ib = priorityTags.indexOf(b.tag!); if (ia === -1) ia = 999; if (ib === -1) ib = 999; if (ia !== ib) return ia - ib; return a.tag!.localeCompare(b.tag!); });

                const seenRows = new Set<string>();
                for (const m of items) {
                    const tagKey = m.tag!;
                    seenRows.add(tagKey);
                    let row = groupInfo.rows.get(tagKey);
                    if (!row) {
                        row = document.createElement('div');
                        row.className = 'meta-row';
                        const keySpan = document.createElement('span'); keySpan.className = 'meta-key'; keySpan.textContent = m.tag || '';
                        const valSpan = document.createElement('span'); valSpan.className = 'meta-val';
                        const search = document.createElement('span'); search.className = 'meta-search-btn'; search.textContent = '\uD83D\uDD0D'; search.title = 'Search';
                        row.appendChild(keySpan); row.appendChild(valSpan); row.appendChild(search);
                        groupInfo.container.appendChild(row);
                        groupInfo.rows.set(tagKey, row);
                    }
                    const valSpan = row.querySelector('.meta-val') as HTMLElement;
                    valSpan.textContent = m.value || '';
                    const searchBtn = row.querySelector('.meta-search-btn') as HTMLElement;
                    searchBtn.onclick = () => hub.pub(ps.SEARCH_TRIGGERED, { tag: m.tag!, value: m.value! });
                }

                for (const [tag, rowEl] of groupInfo.rows.entries()) {
                    if (!seenRows.has(tag)) {
                        rowEl.remove();
                        groupInfo.rows.delete(tag);
                    }
                }
            }

            for (const [groupName, info] of this.metaGroups.entries()) {
                if (!seenGroups.has(groupName)) {
                    info.container.remove();
                    this.metaGroups.delete(groupName);
                }
            }

        } catch (err) { 
            console.error(err);
            if (this.metadataEl) this.metadataEl.textContent = 'Error loading metadata'; 
        }
    }

    private toggleLibraryPanel() {
        if (!this.layout) return;
        const libraryItem = this.layout.root.getItemsByFilter((item: any) => item.config.componentName === 'library')[0];
        const expandBtn = document.getElementById('lib-expand-btn');
        
        if (libraryItem) {
            libraryItem.remove();
            if (expandBtn) expandBtn.style.display = 'inline-block';
        } else {
            // Restore Library
            if (this.layout.root.contentItems.length > 0) {
                const rootRow = this.layout.root.contentItems[0];
                rootRow.addChild({
                    type: 'component',
                    componentName: 'library',
                    width: 20,
                    title: 'Library',
                    isClosable: false
                }, 0); // index 0 to put it on left
            }
            if (expandBtn) expandBtn.style.display = 'none';
        }
    }

    private toggleMetadataPanel() {
        if (!this.layout) return;
        const metadataItems = this.layout.root.getItemsByFilter((item: any) => item.config.componentName === 'metadata');
        
        if (metadataItems.length > 0) {
            // Already exists, close it
            metadataItems[0].remove();
        } else {
            // Missing, find workspace and add next to it
            const workspaceItems = this.layout.root.getItemsByFilter((item: any) => item.config.componentName === 'workspace');
            if (workspaceItems.length > 0) {
                const parent = workspaceItems[0].parent;
                parent.addChild({
                    type: 'component',
                    componentName: 'metadata',
                    width: 20,
                    title: 'Metadata'
                });
            } else {
                // Fallback: add to root
                if (this.layout.root.contentItems.length > 0) {
                    this.layout.root.contentItems[0].addChild({
                        type: 'component',
                        componentName: 'metadata',
                        width: 20,
                        title: 'Metadata'
                    });
                }
            }
        }
    }

    private handleKey(e: KeyboardEvent) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
        if ((e.target as HTMLElement).isContentEditable) return;
        
        const key = e.key.toLowerCase();
        if (key === 'escape') {
            if (this.isFullscreen) this.toggleFullscreen();
        }
        if (key === 'g') {
            if (this.isFullscreen) this.toggleFullscreen();
            hub.pub(ps.VIEW_MODE_CHANGED, { mode: 'grid' });
        }
        if (key === 'l' || key === 'enter' || e.key === ' ') {
            e.preventDefault();
            if (this.isFullscreen) this.toggleFullscreen();
            hub.pub(ps.VIEW_MODE_CHANGED, { mode: 'loupe', id: this.selectedId || undefined });
        }
        if (key === 'f') {
            e.preventDefault();
            this.toggleFullscreen();
        }
        if (key === 'm') {
            e.preventDefault();
            this.toggleMetadataPanel();
        }
        if (key === 'b') {
            e.preventDefault();
            this.toggleLibraryPanel();
        }
        if (key === 'p') {
            if (this.selectedId) {
                const p = this.photos.find(x => x.id === this.selectedId);
                if (p) server.togglePick(p);
            }
        }
        if (key >= '0' && key <= '5') {
            if (this.selectedId) {
                const p = this.photos.find(x => x.id === this.selectedId);
                if (p) server.setRating(p, parseInt(key));
            }
        }
        if (key === '?' || key === '/') { if (key === '?' || (key === '/' && e.shiftKey)) { e.preventDefault(); hub.pub(ps.SHORTCUTS_SHOW, {}); } }
        
        if (key === '[') {
            if (this.selectedId) {
                if (this.isLoupeMode && this.rotateLeft) this.rotateLeft();
                else {
                    const current = this.rotationMap.get(this.selectedId) || 0;
                    hub.pub(ps.PHOTO_ROTATED, { id: this.selectedId, rotation: current - 90 });
                }
            }
        }
        if (key === ']') {
            if (this.selectedId) {
                if (this.isLoupeMode && this.rotateRight) this.rotateRight();
                else {
                    const current = this.rotationMap.get(this.selectedId) || 0;
                    hub.pub(ps.PHOTO_ROTATED, { id: this.selectedId, rotation: current + 90 });
                }
            }
        }

        if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(e.key.toLowerCase())) {
            e.preventDefault();
            this.navigate(e.key);
        }

        if (key === 'pageup' || key === 'pagedown') {
            e.preventDefault();
            this.navigateFolders(key === 'pageup' ? 'prev' : 'next');
        }
    }

    private navigateFolders(direction: 'next' | 'prev') {
        if (this.flatFolderList.length === 0) return;
        
        let index = this.selectedRootId ? this.flatFolderList.indexOf(this.selectedRootId) : -1;
        
        if (direction === 'next') index++;
        else index--;

        index = Math.max(0, Math.min(this.flatFolderList.length - 1, index));
        const targetId = this.flatFolderList[index];
        
        if (targetId && targetId !== this.selectedRootId) {
            this.setFilter('all', 0, targetId);
            // Scrolling is handled by renderFolderTree which is triggered by setFilter -> refreshPhotos
        }
    }

    private navigate(key: string) {
        if (this.photos.length === 0) return;
        
        let index = this.selectedId ? this.photos.findIndex(p => p?.id === this.selectedId) : -1;
        
        if (key === 'ArrowRight') index++; 
        else if (key === 'ArrowLeft') index--;
        else if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (this.isLoupeMode || this.isFullscreen) { if (key === 'ArrowDown') index++; else index--; }
            else { 
                const cols = this.gridViewManager.getColumnCount();
                if (key === 'ArrowDown') index += cols; else index -= cols; 
            }
        }
        
                index = Math.max(0, Math.min(this.photos.length - 1, index));
        
                const target = this.photos[index];
        
                if (target) {
        
                    hub.pub(ps.PHOTO_SELECTED, { id: target.id, photo: target });
        
                    // Always scroll to photo in background to keep grid in sync
        
                    this.gridViewManager.scrollToPhoto(target.id);
        
                }
        
            }
        
        
        
            private setupGlobalKeyboard() {
        
                document.addEventListener('keydown', (e) => this.handleKey(e));
        
            }
        
        }
        
        
        
        const app = new App();
        
        window.app = app;
        
        hub.pub(ps.UI_LAYOUT_CHANGED, {}); hub.pub(ps.CONNECTION_CHANGED, { connected: false, connecting: true });
        
        