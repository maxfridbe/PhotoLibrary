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
import { patch, h, VNode } from './snabbdom-setup.js';
import { PhotoCard } from './components/grid/PhotoCard.js';
import { LibrarySidebar, LibrarySidebarProps } from './components/library/LibrarySidebar.js';
import { LoupeView } from './components/loupe/LoupeView.js';
import { ApertureVisualizer } from './components/aperature/ApertureVisualizer.js';
import { MetadataPanel } from './components/metadata/MetadataPanel.js';
import { ShortcutsDialog } from './components/common/ShortcutsDialog.js';
import { SettingsModal } from './components/common/SettingsModal.js';
import { NotificationManager, Notification } from './components/common/NotificationManager.js';

const ps = constants.pubsub;

type Photo = Res.PhotoResponse;
import { visualizeLensData } from './aperatureVis.js';

type MetadataGroup = Res.MetadataGroupResponse;
type RootPath = Res.DirectoryNodeResponse;
type Collection = Res.CollectionResponse;
type Stats = Res.StatsResponse;

type SortOption = 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc' | 'rating-desc' | 'size-desc';

interface FolderTreeNode {
    node: RootPath;
    children: FolderTreeNode[];
}

export interface SavedSearch {
    id: string;
    title: string;
    tag?: string;
    value?: string;
    query?: string;
}

declare global {
    interface Window {
        app: App;
    }
}

// REQ-ARCH-00003
class App {
    public layout: any;
    private themeManager: ThemeManager;
    public libraryManager: LibraryManager;
    public gridViewManager: GridView;

    private allPhotosFlat: Photo[] = []; 
    public photos: Photo[] = []; // Processed list
    
    private photoMap: Map<string, Photo> = new Map();
    private roots: Res.DirectoryNodeResponse[] = [];
    public userCollections: Collection[] = [];
    public savedSearches: SavedSearch[] = [];
    public stats: Stats = { totalCount: 0, pickedCount: 0, ratingCounts: [0,0,0,0,0] };
    public totalPhotos = 0;
    
    private expandedFolders: Set<string> = new Set();
    private flatFolderList: string[] = [];

    private imageUrlCache: Map<string, string> = new Map();
    private cameraThumbCache: Map<string, string> = new Map();

    public selectedId: string | null = null;
    public anchorId: string | null = null;
    public selectedIds: Set<string> = new Set();
    public selectedMetadata: MetadataGroup[] = [];
    public selectedRootId: string | null = null;
    private lastSelectedRootId: string | null = null;
    public selectedCollectionId: string | null = null;
    public selectedSavedSearchId: string | null = null;
    public filterType: 'all' | 'picked' | 'rating' | 'search' | 'collection' = 'all';
    public filterRating: number = 0;
    public stackingEnabled: boolean = false;
    public sortBy: SortOption = 'date-desc';
    
    public searchResultIds: string[] = [];
    public searchTitle: string = '';
    public searchTag: string | null = null;
    public searchValue: string | null = null;
    public searchQuery: string | null = null;
    public collectionFiles: string[] = [];

    private hiddenIds: Set<string> = new Set();
    public showHidden: boolean = false;

    private gridScale = 1.0;
    private isLoadingChunk = new Set<number>();
    public rotationMap = new Map<string, number>();
    private prioritySession = 1;

    public isLoupeMode = false;
    public isLibraryMode = false;
    public isIndexing = false;
    private overlayFormat = '{Filename}\n{Takendate}\n{Takentime}';
    
    private isShortcutsVisible = false;
    private isSettingsVisible = false;

    // View methods added during layout registration
    public setViewTransform?: (r: number, s: number, pl: number, pt: number) => void;
    public rotateLeft?: () => void;
    public rotateRight?: () => void;
    public getPriority?: (id: string) => number;

    private findDirectoryById(nodes: Res.DirectoryNodeResponse[], id: string): Res.DirectoryNodeResponse | null {
        for (const n of nodes) {
            if (n.id === id) return n;
            const found = this.findDirectoryById(n.children, id);
            if (found) return found;
        }
        return null;
    }

    private updateWatermark() {
        if (!this.$watermarkEl) return;
        let name = '';
        if (this.filterType === 'all' && this.selectedRootId) {
            const node = this.findDirectoryById(this.roots, this.selectedRootId);
            name = node ? node.name : '';
        } else if (this.filterType === 'collection' && this.selectedCollectionId) {
            const c = this.userCollections.find(x => x.id === this.selectedCollectionId);
            name = c ? c.name : '';
        } else if (this.filterType === 'picked') {
            name = 'Picked';
        } else if (this.filterType === 'rating') {
            name = 'Starred';
        } else if (this.filterType === 'search') {
            name = 'Search';
        } else {
            name = 'All Photos';
        }
        this.$watermarkEl.textContent = name;
    }

    public async togglePinSearch() {
        if (this.filterType !== 'search') return;
        
        // Find if current search is already pinned
        const existing = this.savedSearches.find(s => s.tag === this.searchTag && s.value === this.searchValue && s.query === this.searchQuery);
        
        if (existing) {
            await this.removeSavedSearch(existing.id);
        } else {
            const title = prompt('Name for this saved search:', this.searchTitle) || this.searchTitle;
            const newSearch: SavedSearch = {
                id: Math.random().toString(36).substring(2, 9),
                title,
                tag: this.searchTag || undefined,
                value: this.searchValue || undefined,
                query: this.searchQuery || undefined
            };
            this.savedSearches.push(newSearch);
            await this.saveSavedSearches();
            this.selectedSavedSearchId = newSearch.id;
            this.renderLibrary();
        }
    }

    public async setSavedSearchFilter(s: SavedSearch) {
        await this.searchPhotos(s.tag || null, s.value || null, s.query);
        this.selectedSavedSearchId = s.id;
        this.renderLibrary();
    }

    public async removeSavedSearch(id: string) {
        this.savedSearches = this.savedSearches.filter(s => s.id !== id);
        if (this.selectedSavedSearchId === id) this.selectedSavedSearchId = null;
        await this.saveSavedSearches();
        this.renderLibrary();
    }

    private async saveSavedSearches() {
        try {
            await Api.api_settings_set({ key: 'saved-searches', value: JSON.stringify(this.savedSearches) });
        } catch (e) { console.error("Failed to save searches", e); }
    }
    
    // Connection State
    private runtimeStats: any = null;
    private disconnectedAt: number | null = null;
    private isConnected: boolean = false;
    private isConnecting: boolean = false;
    private statusInterval: any = null;

    // Fullscreen state
    private isFullscreen: boolean = false;
    private isApplyingUrl = false;
    private $fullscreenOverlay: HTMLElement | null = null;
    private $fullscreenImgPlaceholder: HTMLImageElement | null = null;
    private $fullscreenImgHighRes: HTMLImageElement | null = null;
    private $fullscreenSpinner: HTMLElement | null = null;

    public $libraryEl: HTMLElement | null = null;
    public $workspaceEl: HTMLElement | null = null;
    public $metadataEl: HTMLElement | null = null;
    public $gridHeader: HTMLElement | null = null;
    public $gridView: HTMLElement | null = null;
    public $scrollSentinel: HTMLElement | null = null;
    public $loupeView: HTMLElement | null = null;
    public $filmstrip: HTMLElement | null = null;
    private $watermarkEl: HTMLElement | null = null;

    private $metaTitleEl: HTMLElement | null = null;
    public $metaVisEl: HTMLElement | null = null;
    private apertureVNode: VNode | HTMLElement | null = null;
    private libraryVNode: VNode | HTMLElement | null = null;
    private loupeVNode: VNode | HTMLElement | null = null;
    private metadataVNode: VNode | HTMLElement | null = null;
    private modalsVNode: VNode | HTMLElement | null = null;
    private notificationsVNode: VNode | HTMLElement | null = null;
    private showQueryBuilder = false;
    private overlayText = '';
    private notifications: Notification[] = [];
    private notificationIdCounter = 0;
    private metaGroups: Map<string, { container: HTMLElement, rows: Map<string, HTMLElement> }> = new Map();

    private importedBatchCount = 0;
    private importedBatchTimer: any = null;
    private directoryRefreshTimer: any = null;
    private importedQueue: { id: string, path: string, rootId?: string }[] = [];
    private importProcessTimer: any = null;
    private folderProgress: Map<string, { processed: number, total: number, thumbnailed?: number }> = new Map();
    private loadStartTime: number = Date.now();

    private updateSplash(status: string, percent: number) {
        const $status = document.getElementById('splash-status');
        const $progress = document.getElementById('splash-progress');
        if ($status) $status.textContent = status;
        if ($progress) $progress.style.width = percent + '%';
    }

    private hideSplash() {
        const $splash = document.getElementById('splash-screen');
        if ($splash) {
            $splash.style.opacity = '0';
            $splash.style.pointerEvents = 'none';
            setTimeout(() => {
                $splash.style.display = 'none';
            }, 500);
        }
        
        if (this.layout) {
            this.layout.updateSize();
        }
        hub.pub(ps.UI_LAYOUT_CHANGED, {});
    }

    constructor() {
        this.loadStartTime = Date.now();
        this.updateSplash('Loading Theme...', 10);
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
            this.renderLibrary();
        });

        hub.sub(ps.FOLDER_FINISHED, (data) => {
            this.folderProgress.delete(data.rootId);
            this.renderLibrary();
            this.showNotification('Thumbnail generation finished', 'success');
            this.refreshDirectories(); // Refresh stats from DB
        });

        this.themeManager.loadSettings().then(() => {
            this.updateSplash('Applying Styles...', 30);
            this.themeManager.populateThemesDropdown();
            this.themeManager.applyTheme();
            this.updateSplash('Initializing Layout...', 50);
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

            // Init modals
            this.renderModals();
            this.renderNotifications();
            document.getElementById('settings-trigger')?.addEventListener('click', () => {
                this.isSettingsVisible = true;
                this.renderModals();
            });
        });
    }

    private renderModals() {
        const container = document.getElementById('modals-container');
        if (!container) return;

        const shortcuts = ShortcutsDialog({
            isVisible: this.isShortcutsVisible,
            onClose: () => { this.isShortcutsVisible = false; this.renderModals(); }
        });

        const settings = SettingsModal({
            isVisible: this.isSettingsVisible,
            currentTheme: this.themeManager.getCurrentTheme(),
            overlayFormat: this.themeManager.getOverlayFormat(),
            appName: this.themeManager.getAppName(),
            onClose: () => { this.isSettingsVisible = false; this.renderModals(); },
            onThemeChange: (t) => { this.setTheme(t); this.renderModals(); },
            onOverlayFormatChange: (f) => { this.setOverlayFormat(f); this.renderModals(); },
            onAppNameChange: (n) => { this.themeManager.setAppName(n); this.renderModals(); },
            onResetLayout: () => { this.resetLayout(); this.isSettingsVisible = false; this.renderModals(); }
        });

        const vnode = h('div#modals-container', [shortcuts, settings]);
        this.modalsVNode = patch(this.modalsVNode || container, vnode);
    }

    public setTheme(name: string) { this.themeManager.setTheme(name); }

    public async setOverlayFormat(format: string) {
        await this.themeManager.setOverlayFormat(format);
        if (this.selectedId) this.updateLoupeOverlay(this.selectedId);
    }

    private updateLoupeOverlay(id: string) {
        const photo = this.photoMap.get(id);
        if (!photo || !this.isLoupeMode) {
            this.overlayText = '';
            this.renderLoupe();
            return;
        }

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
            for (const group of this.selectedMetadata) {
                if (group.items[tag]) return group.items[tag];
            }
            return '';
        });
        
        this.overlayText = text;
        this.renderLoupe();
    }

    private initPubSub() {
        hub.sub(ps.PHOTO_SELECTED, (data) => {
            const id = data.id;
            const mods = this.isLoupeMode ? { shift: false, ctrl: false } : (data.modifiers || { shift: false, ctrl: false });

            if (mods.shift) {
                // Range select from anchor
                const anchor = this.anchorId || this.selectedId || id;
                const startIdx = this.photos.findIndex(p => p.id === anchor);
                const endIdx = this.photos.findIndex(p => p.id === id);
                
                if (startIdx !== -1 && endIdx !== -1) {
                    const low = Math.min(startIdx, endIdx);
                    const high = Math.max(startIdx, endIdx);
                    
                    if (!mods.ctrl) {
                        this.selectedIds.clear();
                    }
                    
                    for (let i = low; i <= high; i++) {
                        this.selectedIds.add(this.photos[i].id);
                    }
                } else {
                    // Fallback
                    if (!mods.ctrl) this.selectedIds.clear();
                    this.selectedIds.add(id);
                    this.anchorId = id;
                }
            } else if (mods.ctrl) {
                if (this.selectedIds.has(id)) {
                    this.selectedIds.delete(id);
                } else {
                    this.selectedIds.add(id);
                }
                this.anchorId = id;
            } else {
                this.selectedIds.clear();
                this.selectedIds.add(id);
                this.anchorId = id;
            }

            // If we have selections, ensure active ID is valid or set to the clicked one
            if (this.selectedIds.size > 0) {
                // If we clicked something, it becomes active (anchor), even if we toggled it off?
                // Standard: if we toggle off, anchor might move. But let's keep the clicked one as active/anchor.
                this.selectedId = id;
                
                // If we toggled OFF the clicked one, selectedId refers to an unselected item.
                // This is allowed in some apps (anchor is focus).
                // But for metadata panel, we usually show the active item.
            } else {
                this.selectedId = null;
            }

            // Sync Grid
            this.gridViewManager.setSelected(this.selectedId, this.selectedIds);
            
            // Sync selection UI (legacy/filmstrip scrolling)
            // We only scroll to the active one
            if (this.selectedId) {
                this.gridViewManager.scrollToPhoto(this.selectedId);
                this.loadMetadata(this.selectedId);
                if (this.isLoupeMode && this.selectedIds.has(this.selectedId)) {
                     // Ensure loupe matches active selection
                }
            } else {
                this.clearMetadata();
            }
            
            // Fullscreen & Loupe updates
            if (this.selectedId) {
                if (this.isFullscreen) {
                    this.updateFullscreenImage(this.selectedId);
                    if (this.isLoupeMode) {
                        this.renderLoupe();
                        this.updateLoupeOverlay(this.selectedId);
                    }
                } else if (this.isLoupeMode) {
                    this.renderLoupe();
                    this.updateLoupeOverlay(this.selectedId);
                }
            }
            
            if (this.$workspaceEl) this.$workspaceEl.focus();
            this.syncUrl();
        });

        hub.sub(ps.VIEW_MODE_CHANGED, (data) => {
            this.isLoupeMode = data.mode === 'loupe';
            this.updateViewModeUI();
            if (data.mode === 'loupe' && data.id) {
                hub.pub(ps.PHOTO_SELECTED, { id: data.id, photo: this.photoMap.get(data.id)! });
                this.updateLoupeOverlay(data.id);
            } else if (data.mode === 'loupe') {
                this.renderLoupe();
            }
            this.syncUrl();
        });

        hub.sub(ps.PHOTO_UPDATED, (data) => {
            // Update local map
            const updatedPhoto = { ...this.photoMap.get(data.id), ...data.photo };
            this.photoMap.set(data.id, updatedPhoto);
            
            // Update flat list
            const flatIdx = this.allPhotosFlat.findIndex(p => p.id === data.id);
            if (flatIdx !== -1) this.allPhotosFlat[flatIdx] = updatedPhoto;

            // If stacking is enabled, re-evaluate everything as this photo might change a stack representative's state
            if (this.stackingEnabled || this.sortBy === 'rating-desc') {
                this.processUIStacks();
            } else {
                // If not stacking, we can try to update in place
                const idx = this.photos.findIndex(p => p.id === data.id);
                if (idx !== -1) {
                    this.photos[idx] = updatedPhoto;
                    this.gridViewManager.refreshStats(data.id, this.photos);
                } else {
                    // Not in current list (maybe filtered out), but let's refresh just in case
                    this.gridViewManager.update(true);
                }
            }

            if (this.selectedId === data.id) {
                this.updateSelectionUI(data.id);
                if (this.isLoupeMode) this.updateLoupeOverlay(data.id);
            }
        });

        hub.sub(ps.PHOTO_ROTATED, (data) => {
            this.rotationMap.set(data.id, data.rotation);
            this.gridViewManager.refreshStats(data.id, this.photos);
            this.savePhotoPreferences(data.id, data.rotation);
            
            // Update loupe
            if (this.selectedId === data.id && this.isLoupeMode) {
                this.renderLoupe();
            }

            // Update fullscreen image
            if (this.isFullscreen && this.selectedId === data.id) {
                if (this.$fullscreenImgPlaceholder) this.$fullscreenImgPlaceholder.style.transform = `rotate(${data.rotation}deg)`;
                if (this.$fullscreenImgHighRes) this.$fullscreenImgHighRes.style.transform = `rotate(${data.rotation}deg)`;
            }
        });

        hub.sub(ps.SEARCH_TRIGGERED, (data) => this.searchPhotos(data.tag || null, data.value || null, data.query));

        hub.sub(ps.SHORTCUTS_SHOW, () => {
            this.isShortcutsVisible = true;
            this.renderModals();
        });

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
            this.handlePhotoImported(data);

            this.importedBatchCount++;
            if (this.importedBatchTimer) clearTimeout(this.importedBatchTimer);
            this.importedBatchTimer = setTimeout(() => {
                this.showNotification(`Imported ${this.importedBatchCount} photos`, 'success');
                this.importedBatchCount = 0;
                this.loadData();
            }, 1000);
        });

        hub.sub(ps.FOLDER_CREATED, (data) => {
            console.log(`[App] Folder created: ${data.name}`);
            if (!this.directoryRefreshTimer) {
                this.directoryRefreshTimer = setTimeout(() => {
                    this.refreshDirectories().catch(e => console.error("Refresh dirs failed", e));
                    this.directoryRefreshTimer = null;
                }, 500);
            }
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
                    this.renderLibrary();
                }
            }
        });

        hub.sub(ps.RUNTIME_STATS, (data) => {
            this.runtimeStats = data;
            this.updateStatusUI();
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

    public async toggleHide(id: string) {
        if (!this.selectedRootId) return; // Only allow hiding in folder view for now
        
        const photo = this.photoMap.get(id);
        if (!photo) return;

        const targetIds = photo.stackFileIds && photo.stackFileIds.length > 0 ? photo.stackFileIds : [id];
        let changed = false;

        targetIds.forEach(tid => {
            if (this.hiddenIds.has(tid)) {
                this.hiddenIds.delete(tid);
                changed = true;
            } else {
                this.hiddenIds.add(tid);
                changed = true;
            }
        });

        if (changed) {
            this.saveHiddenSettings();
            
            if (!this.showHidden) {
                this.allPhotosFlat = this.allPhotosFlat.filter(p => !this.hiddenIds.has(p.id));
                this.processUIStacks();
            } else {
                this.gridViewManager.update(true);
            }
        }
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

    private async handlePhotoImported(data: { id: string, path: string, rootId?: string }) {
        // Immediate UI updates for counts
        this.stats.totalCount++;
        if (data.rootId) {
            const root = this.folderNodeMap.get(data.rootId);
            if (root) {
                root.imageCount++;
                const el = document.getElementById(`folder-item-${data.rootId}`);
                if (el) {
                    const countEl = el.querySelector('.count');
                    if (countEl) countEl.textContent = root.imageCount.toString();
                }
            }
        }
        this.updateSidebarCountsOnly();

        // Queue for grid update
        this.importedQueue.push(data);
        if (this.importProcessTimer) clearTimeout(this.importProcessTimer);
        this.importProcessTimer = setTimeout(() => this.processImportQueue(), 100);
    }

    private async processImportQueue() {
        const queue = [...this.importedQueue];
        this.importedQueue = [];
        
        const idsToFetch: string[] = [];
        for (const data of queue) {
            let matches = false;
            if (this.filterType === 'all') {
                if (!this.selectedRootId || this.selectedRootId === data.rootId) {
                    matches = true;
                }
            }
            if (matches && !this.photoMap.has(data.id)) {
                idsToFetch.push(data.id);
            }
        }

        if (idsToFetch.length > 0) {
            const res = await Api.api_photos({ specificIds: idsToFetch });
            if (res.photos) {
                let changed = false;
                for (const photo of res.photos) {
                    if (!this.photoMap.has(photo.id)) {
                        this.photoMap.set(photo.id, photo);
                        this.allPhotosFlat.push(photo);
                        changed = true;
                    }
                }
                if (changed) {
                    this.processUIStacks();
                }
            }
        }
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
                rep.stackExtensions = exts.join(',');

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
        
        this.updateWatermark();
        this.renderGrid();
        if (this.isLoupeMode) this.renderFilmstrip();
    }

    private clearMetadata() {
        if (this.$metadataEl) this.$metadataEl.innerHTML = '';
        this.$metaTitleEl = null;
        this.metaGroups.clear();
    }

    public showNotification(message: string, type: 'info' | 'error' | 'success') {
        const id = ++this.notificationIdCounter;
        this.notifications.push({ id, message, type });
        this.renderNotifications();

        setTimeout(() => {
            this.notifications = this.notifications.filter(n => n.id !== id);
            this.renderNotifications();
        }, 3000);
    }

    private renderNotifications() {
        const container = document.getElementById('notifications-mount');
        if (!container) return;
        this.notificationsVNode = patch(this.notificationsVNode || container, NotificationManager({ notifications: this.notifications }));
    }

    private updateStatusUI() {
        const el = document.getElementById('connection-status');
        if (!el) return;

        if (this.isConnected) {
            el.textContent = 'Connected';
            el.style.color = '#0f0';

            if (this.runtimeStats) {
                const s = this.runtimeStats;
                const mem = (s.memoryBytes / 1024 / 1024 / 1024).toFixed(2).replace(/^0+/, '') + 'g';
                const bw = s.sentBytesPerSec + s.recvBytesPerSec;
                // Convert bytes/sec to bits/sec for "bps" or just maintain bytes/sec as implied by "mbps" usually meaning megabits but often used loosely?
                // The prompt asked for "1mbps" or "500kbps". Usually mbps = megabits per second.
                // My stats are in bytes/sec. So * 8 for bits.
                const bits = bw * 8;
                let bwStr = '';
                if (bits > 1024 * 1024) bwStr = (bits / 1024 / 1024).toFixed(1) + 'mbps';
                else bwStr = (bits / 1024).toFixed(0) + 'kbps';
                
                const statsSpan = document.createElement('span');
                statsSpan.style.color = '#888';
                statsSpan.style.marginLeft = '10px';
                statsSpan.textContent = `(${mem}) (${bwStr})`;
                statsSpan.title = "Memory Usage / Network Bandwidth";
                statsSpan.setAttribute('aria-label', 'Memory Usage');
                el.appendChild(statsSpan);
            }
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
        this.updateFlatFolderList();
        this.renderLibrary();
    }

    private parentMap: Map<string, string> = new Map();
    private folderNodeMap: Map<string, Res.DirectoryNodeResponse> = new Map();

    private updateFlatFolderList() {
        this.flatFolderList = [];
        this.parentMap.clear();
        this.folderNodeMap.clear();
        
        const walk = (nodes: Res.DirectoryNodeResponse[], parentId: string | null) => {
            const sorted = [...nodes].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            
            sorted.forEach(node => {
                this.flatFolderList.push(node.id);
                this.folderNodeMap.set(node.id, node);
                if (parentId) this.parentMap.set(node.id, parentId);
                
                if (node.children && node.children.length > 0) {
                    walk(node.children, node.id);
                }
            });
        };
        
        walk(this.roots, null);
    }

    private updateSidebarCountsOnly() {
        if (!this.$libraryEl) return;
        const allCountEl = this.$libraryEl.querySelector('.tree-item[data-type="all"] .count');
        if (allCountEl) allCountEl.textContent = this.stats.totalCount.toString();

        const pickedCountEl = this.$libraryEl.querySelector('.tree-item[data-type="picked"] .count');
        if (pickedCountEl) pickedCountEl.textContent = this.stats.pickedCount.toString();
        for (let i = 1; i <= 5; i++) {
            const countEl = this.$libraryEl.querySelector(`.tree-item[data-type="rating-${i}"] .count`);
            if (countEl) countEl.textContent = this.stats.ratingCounts[i-1].toString();
        }
    }

    // REQ-WFE-00008
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
        params.set('hidden', this.showHidden.toString());

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
                if (params.has('hidden')) {
                    const newHidden = params.get('hidden') === 'true';
                    if (newHidden !== this.showHidden) { this.showHidden = newHidden; stackChanged = true; }
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

                if (this.selectedRootId) {
                    await this.loadHiddenSettings(this.selectedRootId);
                } else {
                    this.hiddenIds.clear();
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
            if (this.isLibraryMode) {
                this.enterLibraryMode();
            }
        } finally {
            this.isApplyingUrl = false;
        }
    }

    private async loadHiddenSettings(rootId: string) {
        this.hiddenIds.clear();
        try {
            const res = await Api.api_settings_get({ name: `settings.${rootId}` });
            if (res && res.value) {
                const data = JSON.parse(res.value);
                if (data.hidden && Array.isArray(data.hidden)) {
                    this.hiddenIds = new Set(data.hidden);
                }
            }
        } catch (e) { console.error("Failed to load hidden settings", e); }
    }

    private async saveHiddenSettings() {
        if (!this.selectedRootId) return;
        try {
            const data = { hidden: Array.from(this.hiddenIds) };
            await Api.api_settings_set({ key: `settings.${this.selectedRootId}`, value: JSON.stringify(data) });
        } catch (e) { console.error("Failed to save hidden settings", e); }
    }

    private updateHeaderUI() {
        const sortSelect = document.getElementById('grid-sort-select') as HTMLSelectElement;
        if (sortSelect) sortSelect.value = this.sortBy;

        const stackCheck = document.getElementById('grid-stack-check') as HTMLInputElement;
        if (stackCheck) stackCheck.checked = this.stackingEnabled;

        const hiddenCheck = document.getElementById('grid-hidden-check') as HTMLInputElement;
        if (hiddenCheck) hiddenCheck.checked = this.showHidden;

        const scaleSlider = document.getElementById('grid-scale-slider') as HTMLInputElement;
        if (scaleSlider) scaleSlider.value = this.gridScale.toString();
    }

    async loadData() {
        try {
            this.updateSplash('Fetching Library Data...', 60);
            const [roots, colls, stats, expState, searchesState] = await Promise.all([
                Api.api_directories({}),
                Api.api_collections_list({}),
                Api.api_stats({}),
                Api.api_settings_get({ name: 'folder-expanded-state' }),
                Api.api_settings_get({ name: 'saved-searches' })
            ]);
            this.roots = roots;
            this.updateFlatFolderList();
            this.userCollections = colls;
            this.stats = stats;

            if (expState && expState.value) {
                try {
                    const ids = JSON.parse(expState.value);
                    if (Array.isArray(ids)) this.expandedFolders = new Set(ids);
                } catch (e) { console.error("Failed to parse expanded folders", e); }
            }

            if (searchesState && searchesState.value) {
                try {
                    this.savedSearches = JSON.parse(searchesState.value);
                } catch (e) { console.error("Failed to parse saved searches", e); }
            }
            
            this.updateSplash('Synchronizing View State...', 80);
            if (window.location.hash.startsWith('#!/')) {
                await this.applyUrlState();
            } else {
                await this.refreshPhotos();
            }
            this.updateSplash('Ready', 100);
            const elapsed = Date.now() - this.loadStartTime;
            const minDelay = 2000;
            const remaining = Math.max(0, minDelay - elapsed);
            setTimeout(() => this.hideSplash(), remaining);
        } catch (e) { 
            console.error("Load failed", e); 
            this.updateSplash('Load Failed', 100);
            setTimeout(() => this.hideSplash(), 1000);
        }
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
        
        // Filter hidden items
        if (this.selectedRootId && this.hiddenIds.size === 0) {
            // Lazy load if not already loaded
            await this.loadHiddenSettings(this.selectedRootId);
        }

        if (!this.showHidden && this.hiddenIds.size > 0) {
            this.allPhotosFlat = this.allPhotosFlat.filter(p => !this.hiddenIds.has(p.id));
        }

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

        if (keepSelection && this.selectedId) {
            const photo = this.photoMap.get(this.selectedId);
            if (photo) {
                hub.pub(ps.PHOTO_SELECTED, { id: this.selectedId, photo });
            } else {
                // Selection no longer valid in new view, fallback to first
                if (this.photos.length > 0) hub.pub(ps.PHOTO_SELECTED, { id: this.photos[0].id, photo: this.photos[0] });
            }
        } else if (!keepSelection && this.photos.length > 0) {
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
        this.isSettingsVisible = false;
        this.renderModals();
        this.showNotification('Layout reset to default', 'success');
    }

    private initLayout() {
        const config = {
            settings: { showPopoutIcon: false },
            dimensions: { headerHeight: 45 },
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

            self.$libraryEl = document.createElement('div');
            self.libraryVNode = null;
            self.$libraryEl.className = 'tree-view';
            self.$libraryEl.style.flex = '1';
            self.$libraryEl.style.overflowY = 'auto';
            
            wrapper.appendChild(self.$libraryEl);
            container.getElement().append(wrapper);
            
            // Hide the expand button in workspace if library is visible
            const expandBtn = document.getElementById('lib-expand-btn');
            if (expandBtn) expandBtn.style.display = 'none';

            if (self.photos.length > 0) self.renderLibrary();
        });
        this.layout.registerComponent('workspace', function(container: any) {
            console.log('[App] Workspace component initializing...');
            self.$workspaceEl = document.createElement('div');
            self.$workspaceEl.className = 'gl-component';
            self.$workspaceEl.style.overflow = 'hidden';
            self.$workspaceEl.style.position = 'relative'; // Ensure relative for watermark

            const watermark = document.createElement('div');
            watermark.className = 'grid-watermark';
            self.$watermarkEl = watermark;
            self.$workspaceEl.appendChild(watermark);
            
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

            const hiddenLabel = document.createElement('label');
            hiddenLabel.className = 'control-item';
            hiddenLabel.title = 'Show hidden photos';
            const hiddenCheck = document.createElement('input');
            hiddenCheck.id = 'grid-hidden-check';
            hiddenCheck.type = 'checkbox';
            hiddenCheck.checked = self.showHidden;
            hiddenCheck.onchange = (e) => {
                self.showHidden = (e.target as HTMLInputElement).checked;
                self.refreshPhotos(true);
            };
            const hiddenSpan = document.createElement('span');
            hiddenSpan.textContent = 'Hidden';
            hiddenLabel.appendChild(hiddenCheck);
            hiddenLabel.appendChild(hiddenSpan);

            const headerCount = document.createElement('span');
            headerCount.id = 'header-count';
            headerCount.textContent = '0 items';
            
            headerRight.appendChild(scaleLabel);
            headerRight.appendChild(sortLabel);
            headerRight.appendChild(stackLabel);
            headerRight.appendChild(hiddenLabel);
            headerRight.appendChild(headerCount);

            header.appendChild(headerLeft);
            header.appendChild(headerRight);
            self.$workspaceEl.appendChild(header);

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
            const $gridView = document.createElement('div');
            $gridView.id = 'grid-view';
            $gridView.className = 'grid-view';
            $gridView.style.position = 'absolute';
            $gridView.style.top = '0'; $gridView.style.left = '0'; $gridView.style.right = '0';
            gridContainer.appendChild($gridView);
            self.$workspaceEl.appendChild(gridContainer);

            gridContainer.onscroll = () => self.gridViewManager.update();
            console.log('[App] Assigning gridViewEl to manager');
            self.gridViewManager.$gridViewEl = $gridView;
            self.gridViewManager.$scrollSentinel = sentinel;
            if (self.photos.length > 0) self.gridViewManager.update(true);

            self.$loupeView = document.createElement('div');
            self.loupeVNode = null;
            self.$loupeView.id = 'loupe-view-container';
            self.$loupeView.className = 'loupe-view';
            self.$loupeView.style.display = 'none';
            self.$loupeView.style.height = '100%';
            self.$loupeView.style.position = 'relative';
            
            const resizer = document.createElement('div');
            resizer.className = 'filmstrip-resizer';
            resizer.style.display = 'none';
            
            const $filmstrip = document.createElement('div');
            $filmstrip.id = 'filmstrip';
            $filmstrip.className = 'filmstrip';
            $filmstrip.style.display = 'none';
            ($filmstrip.style as CSSStyleDeclaration & { scrollbarGutter: string }).scrollbarGutter = 'stable';
            
            self.$workspaceEl.appendChild(self.$loupeView);
            self.$workspaceEl.appendChild(resizer);
            self.$workspaceEl.appendChild($filmstrip);

            container.getElement().append(self.$workspaceEl);
            
            self.$gridHeader = header;
            self.$gridView = $gridView;
            self.$scrollSentinel = sentinel;
            self.$filmstrip = $filmstrip;
            self.gridViewManager.$filmstripEl = $filmstrip;

            gridContainer.onscroll = () => self.gridViewManager.update();
            
            // Filmstrip Resizer Logic
            let isResizing = false;
            resizer.onmousedown = (e) => { isResizing = true; e.preventDefault(); };
            document.addEventListener('mousemove', (e) => {
                if (!isResizing || !self.$filmstrip) return;
                const offsetTop = self.$loupeView!.getBoundingClientRect().top;
                const totalHeight = self.$loupeView!.clientHeight;
                const newHeight = totalHeight - (e.clientY - offsetTop);
                if (newHeight > 100 && newHeight < 500) {
                    self.$filmstrip.style.height = newHeight + 'px';
                    // Scale cards - we can adjust CSS variable or direct style
                    const cards = self.$filmstrip.querySelectorAll('.card');
                    cards.forEach((c: any) => {
                        c.style.height = (newHeight - 30) + 'px';
                        c.style.width = ((newHeight - 30) * 1.33) + 'px';
                    });
                }
            });
            document.addEventListener('mouseup', () => { isResizing = false; });

            self.$workspaceEl.tabIndex = 0;
            if (self.photos.length > 0) self.renderGrid();
            if (self.isLoupeMode) self.renderLoupe();
        });
        this.layout.registerComponent('metadata', function(container: any) {
            self.$metadataEl = document.createElement('div');
            self.metadataVNode = null;
            self.$metadataEl.className = 'metadata-panel gl-component';
            container.getElement().append(self.$metadataEl);
            if (self.selectedId) self.renderMetadata();
        });
        
        this.layout.init();
        
        // REQ-WFE-00011: Initial renders to ensure content is attached
        this.renderLibrary();
        this.renderGrid();
        this.renderMetadata();

        window.addEventListener('resize', () => { 
            if (this.layout && (this.layout as any).isInitialised) {
                this.layout.updateSize(); 
                hub.pub(ps.UI_LAYOUT_CHANGED, {}); 
            }
        });
        this.layout.on('stateChanged', () => hub.pub(ps.UI_LAYOUT_CHANGED, {}));
    }

    private updateSelectionUI(id: string) {
        // GridView handles selection classes via VDOM now.
        // const oldSel = this.$workspaceEl?.querySelectorAll('.card.selected');
        // oldSel?.forEach(e => e.classList.remove('selected'));
        // const newSel = this.$workspaceEl?.querySelectorAll(`.card[data-id="${id}"]`);
        // newSel?.forEach(e => e.classList.add('selected'));
        
        if (this.isLoupeMode) {
            const stripItem = this.$filmstrip?.querySelector(`.card[data-id="${id}"]`);
            if (stripItem) stripItem.scrollIntoView({ behavior: 'smooth', inline: 'center' });
        }
    }

    private ensureSelectedFolderVisible() {
        if (!this.selectedRootId) return;
        
        // Only auto-expand if the selection has actually changed
        // This allows users to manually collapse the currently selected folder
        if (this.selectedRootId === this.lastSelectedRootId) {
            setTimeout(() => {
                const el = this.$libraryEl?.querySelector(`.tree-item[data-id="${this.selectedRootId}"]`);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 100);
            return;
        }
        
        let changed = false;
        let currentId: string | undefined = this.selectedRootId;

        // Expand the selected folder itself
        if (!this.expandedFolders.has(currentId)) {
            this.expandedFolders.add(currentId);
            changed = true;
        }

        // Trace up and expand ancestors
        while (currentId) {
            const parentId = this.parentMap.get(currentId);
            if (parentId) {
                if (!this.expandedFolders.has(parentId)) {
                    this.expandedFolders.add(parentId);
                    changed = true;
                }
                currentId = parentId;
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

        this.lastSelectedRootId = this.selectedRootId;

        setTimeout(() => {
            const el = this.$libraryEl?.querySelector(`.tree-item[data-id="${this.selectedRootId}"]`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
    }

    // REQ-WFE-00022
    renderLibrary() {
        if (!this.$libraryEl) return;
        this.ensureSelectedFolderVisible();

        const props: LibrarySidebarProps = {
            stats: this.stats,
            roots: this.roots,
            userCollections: this.userCollections,
            savedSearches: this.savedSearches,
            filterType: this.filterType,
            filterRating: this.filterRating,
            selectedRootId: this.selectedRootId,
            selectedCollectionId: this.selectedCollectionId,
            selectedSavedSearchId: this.selectedSavedSearchId,
            searchTitle: this.searchTitle,
            searchResultCount: this.totalPhotos,
            expandedFolders: this.expandedFolders,
            folderProgress: this.folderProgress,
            showQueryBuilder: this.showQueryBuilder,
            isSearchPinned: !!this.savedSearches.find(s => s.tag === this.searchTag && s.value === this.searchValue && s.query === this.searchQuery),
            onFilterChange: (type: any, rating?: number, rootId?: string | null) => this.setFilter(type, rating, rootId),
            onCollectionFilterChange: (c: Collection) => this.setCollectionFilter(c),
            onSavedSearchFilterChange: (s: SavedSearch) => this.setSavedSearchFilter(s),
            onSearch: (query: string) => hub.pub(ps.SEARCH_TRIGGERED, { query }),
            onTogglePinSearch: () => this.togglePinSearch(),
            onInputClick: () => { this.showQueryBuilder = true; this.renderLibrary(); },
            onFolderToggle: (id: string, expanded: boolean) => {
                if (expanded) this.expandedFolders.add(id);
                else this.expandedFolders.delete(id);
                this.renderLibrary();
                Api.api_settings_set({ key: 'folder-expanded-state', value: JSON.stringify(Array.from(this.expandedFolders)) });
            },
            onFolderContextMenu: (e: MouseEvent, id: string) => this.showFolderContextMenu(e, id),
            onPhotoContextMenu: (e: MouseEvent, p: Photo) => this.showPhotoContextMenu(e, p),
            onPickedContextMenu: (e: MouseEvent) => this.showPickedContextMenu(e),
            onCollectionContextMenu: (e: MouseEvent, c: Collection) => this.showCollectionContextMenu(e, c),
            onSavedSearchContextMenu: (e: MouseEvent, s: SavedSearch) => this.showSavedSearchContextMenu(e, s),
            onAnnotationSave: async (id: string, annotation: string, color?: string) => {
                const findNodeById = (nodes: Res.DirectoryNodeResponse[], targetId: string): Res.DirectoryNodeResponse | null => {
                    for (const node of nodes) {
                        if (node.id === targetId) return node;
                        if (node.children) {
                            const found = findNodeById(node.children, targetId);
                            if (found) return found;
                        }
                    }
                    return null;
                };

                const node = findNodeById(this.roots, id);
                if (!node) return;
                const targetColor = color || node.color;
                if (annotation !== (node.annotation || '') || color) {
                    await Api.api_library_set_annotation({ folderId: id, annotation, color: targetColor || undefined });
                    node.annotation = annotation;
                    if (targetColor) node.color = targetColor;
                    this.renderLibrary();
                }
            },
            onCancelTask: (id: string) => Api.api_library_cancel_task({ id: `thumbnails-${id}` })
        };

        if (!this.libraryVNode) {
            this.libraryVNode = this.$libraryEl;
            // Global click listener to hide query builder
            document.addEventListener('click', (e) => {
                const searchBox = this.$libraryEl?.querySelector('.search-box');
                if (this.showQueryBuilder && searchBox && !searchBox.contains(e.target as Node)) {
                    this.showQueryBuilder = false;
                    this.renderLibrary();
                }
            });
        }

        this.libraryVNode = patch(this.libraryVNode, LibrarySidebar(props));
    }

    // REQ-WFE-00016
    setFilter(type: 'all' | 'picked' | 'rating' | 'search' | 'collection', rating: number = 0, rootId: string | null = null, keepSelection: boolean = false) {
        if (this.filterType === type && this.filterRating === rating && this.selectedRootId === rootId && type !== 'collection' && type !== 'search') {
            return;
        }
        this.prioritySession++;
        this.filterType = type;
        this.filterRating = rating;
        this.selectedRootId = rootId;
        this.selectedCollectionId = null;
        this.selectedSavedSearchId = null;
        this.refreshPhotos(keepSelection);
        this.syncUrl();
    }

    async setCollectionFilter(c: Collection) {
        this.prioritySession++;
        this.filterType = 'collection';
        this.selectedCollectionId = c.id;
        this.selectedRootId = null;
        this.selectedSavedSearchId = null;
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
        
        if (this.selectedRootId) {
            const isHidden = this.hiddenIds.has(p.id);
            addItem(isHidden ? 'Unhide Photo (h)' : 'Hide Photo (h)', () => this.toggleHide(p.id));
        }

        // REQ-WFE-00023
        if (this.filterType === 'search' && p.rootPathId) {
            addItem('Reveal in Folders', () => {
                this.setFilter('all', 0, p.rootPathId!, true);
            });
        }
        
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

    showSavedSearchContextMenu(e: MouseEvent, s: SavedSearch) {
        const menu = document.getElementById('context-menu')!;
        menu.innerHTML = '';
        const addItem = (text: string, cb: () => void) => {
            const el = document.createElement('div'); el.className = 'context-menu-item'; el.textContent = text; el.onclick = cb; menu.appendChild(el);
        };
        addItem('Unpin Search', () => this.removeSavedSearch(s.id));
        menu.style.display = 'block'; menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px';
    }

    // REQ-WFE-00018
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
            const res = await Api.api_export_prepare({ fileIds, type, name: exportName });

            if (res && res.token) {
                const token = res.token;
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

    // REQ-WFE-00017
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

    // REQ-WFE-00015
    // REQ-WFE-00021
    async searchPhotos(tag: string | null, value: string | null, query?: string) {
        this.showQueryBuilder = false;
        this.searchTag = tag;
        this.searchValue = value;
        this.searchQuery = query || null;
        this.selectedSavedSearchId = null; 
        
        if (!query && !tag) {
            this.searchResultIds = [];
            this.searchTitle = '';
            this.setFilter('all');
            return;
        }
        const spinner = document.querySelector('.search-loading');
        if (spinner) spinner.classList.add('active');
        
        try {
            this.searchResultIds = await Api.api_search({ tag, value, query });
            this.searchTitle = query ? `Query: ${query}` : `${tag}: ${value}`;
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
        else if (this.selectedRootId) { const root = this.folderNodeMap.get(this.selectedRootId); headerText = root ? `Folder: ${root.name}` : "Folder"; }
        if (this.$gridHeader) {
            const headerTextEl = this.$gridHeader.querySelector('#header-text');
            if (headerTextEl) {
                headerTextEl.innerHTML = '';
                headerTextEl.appendChild(document.createTextNode('Showing '));
                const b = document.createElement('b'); b.textContent = headerText;
                headerTextEl.appendChild(b);
            }
            const headerCountEl = this.$gridHeader.querySelector('#header-count');
            if (headerCountEl) headerCountEl.textContent = `${this.totalPhotos} items`;
        }
    }

    // REQ-WFE-00019
    renderFilmstrip() {
        this.gridViewManager.update(true);
    }

    renderLoupe() {
        if (!this.$loupeView) return;
        const photo = this.selectedId ? this.photoMap.get(this.selectedId) || null : null;
        const props = {
            photo,
            rotation: this.selectedId ? this.rotationMap.get(this.selectedId) || 0 : 0,
            overlayText: this.overlayText,
            imageUrlCache: this.imageUrlCache,
            isVisible: this.isLoupeMode,
            onRotate: (id: string, rot: number) => {
                this.rotationMap.set(id, rot);
                this.savePhotoPreferences(id, rot);
                hub.pub(ps.PHOTO_ROTATED, { id, rotation: rot });
            }
        };

        this.loupeVNode = patch(this.loupeVNode || this.$loupeView, LoupeView(props));
        this.$loupeView = (this.loupeVNode as VNode).elm as HTMLElement;
    }

    selectPhoto(id: string) {
        if (this.selectedId === id) return;
        this.selectedId = id;
        this.updateSelectionUI(id);
        this.loadMetadata(id);
        if (this.isFullscreen) this.updateFullscreenImage(id);
        else if (this.isLoupeMode) this.renderLoupe();
    }

    // REQ-WFE-00012
    enterLoupeMode(id: string) {
        this.prioritySession++;
        this.isLoupeMode = true;
        this.isLibraryMode = false;
        this.updateViewModeUI();
        this.selectPhoto(id);
        this.renderLoupe();
    }

    // REQ-WFE-00012
    enterGridMode() {
        this.isLoupeMode = false;
        this.isLibraryMode = false;
        this.updateViewModeUI();
        if (this.selectedId) this.gridViewManager.scrollToPhoto(this.selectedId);
        this.gridViewManager.update(true);
        this.syncUrl();
    }

    // REQ-WFE-00012
    enterLibraryMode() {
        this.isLoupeMode = false;
        this.isLibraryMode = true;
        this.updateViewModeUI();
        this.libraryManager.initLayout('library-view', () => {});
        this.libraryManager.loadLibraryInfo();
        this.syncUrl();
    }

    private updateViewModeUI() {
        const layoutCont = document.getElementById('layout-container')!;
        const libraryView = document.getElementById('library-view')!;
        
        document.querySelectorAll('.lr-nav-item').forEach(el => el.classList.remove('active'));

        if (this.isLibraryMode) {
            layoutCont.style.display = 'none';
            libraryView.style.display = 'flex';
            document.getElementById('nav-library')?.classList.add('active');
        } else {
            layoutCont.style.display = 'block';
            libraryView.style.display = 'none';
            
            const gridCont = (this.$workspaceEl?.querySelector('#grid-container') as HTMLElement);
            const resizer = (this.$workspaceEl?.querySelector('.filmstrip-resizer') as HTMLElement);
            if (this.isLoupeMode) {
                if (gridCont) gridCont.style.display = 'none';
                if (this.$gridHeader) this.$gridHeader.style.display = 'none';
                this.renderLoupe();
                if (resizer) resizer.style.display = 'block';
                if (this.$filmstrip) this.$filmstrip.style.display = 'flex';
                document.getElementById('nav-loupe')?.classList.add('active');
                this.renderFilmstrip();
            } else {
                this.renderLoupe();
                if (gridCont) gridCont.style.display = 'flex';
                if (this.$gridHeader) this.$gridHeader.style.display = 'flex';
                if (resizer) resizer.style.display = 'none';
                if (this.$filmstrip) this.$filmstrip.style.display = 'none';
                document.getElementById('nav-grid')?.classList.add('active');
                this.gridViewManager.update(true);
            }
        }
    }

    private updateFullscreenImage(id: string) {
        if (!this.$fullscreenImgPlaceholder || !this.$fullscreenImgHighRes || !this.$fullscreenSpinner || !this.$fullscreenOverlay) return;
        
        this.$fullscreenImgHighRes.classList.remove('loaded');
        this.$fullscreenImgHighRes.src = '';
        this.$fullscreenImgPlaceholder.style.display = 'none';
        this.$fullscreenImgPlaceholder.src = '';
        this.$fullscreenSpinner.style.display = 'block';
        
        const rot = this.rotationMap.get(id) || 0;
        this.$fullscreenImgHighRes.style.transform = `rotate(${rot}deg)`;
        this.$fullscreenImgPlaceholder.style.transform = `rotate(${rot}deg)`;

        const dlOrig = this.$fullscreenOverlay.querySelector('.fullscreen-btn:nth-child(2)') as HTMLAnchorElement;
        if (dlOrig) dlOrig.href = `/api/download/${id}`;

        const dlJpg = this.$fullscreenOverlay.querySelector('.fullscreen-btn:nth-child(1)') as HTMLAnchorElement;
        if (dlJpg) dlJpg.removeAttribute('href');

        const lowResKey = id + '-1024';
        const thumbKey = id + '-300';
        const highResKey = id + '-0';
        
        const requestFullRes = () => {
            if (this.imageUrlCache.has(highResKey)) {
                const url = this.imageUrlCache.get(highResKey)!;
                this.$fullscreenImgHighRes!.src = url;
                
                const photo = this.photoMap.get(id);
                if (dlJpg && photo) {
                    dlJpg.href = url;
                    dlJpg.download = (photo.fileName || 'render').split('.')[0] + '_render.jpg';
                }

                if (this.$fullscreenImgHighRes!.complete) {
                    this.$fullscreenImgHighRes!.classList.add('loaded');
                    this.$fullscreenSpinner!.style.display = 'none';
                } else {
                    this.$fullscreenImgHighRes!.onload = () => {
                        if (this.selectedId === id) {
                            this.$fullscreenImgHighRes!.classList.add('loaded');
                            this.$fullscreenSpinner!.style.display = 'none';
                        }
                    };
                }
                return;
            }

            server.requestImage(id, 0).then((blob: Blob) => {
                if (this.selectedId === id && this.isFullscreen) {
                    if (blob.size === 0) {
                        // Error fallback: just stop spinner
                        this.$fullscreenSpinner!.style.display = 'none';
                        return;
                    }

                    const url = URL.createObjectURL(blob);
                    this.imageUrlCache.set(highResKey, url);
                    this.$fullscreenImgHighRes!.src = url;
                    
                    const photo = this.photoMap.get(id);
                    if (dlJpg && photo) {
                        dlJpg.href = url;
                        dlJpg.download = (photo.fileName || 'render').split('.')[0] + '_render.jpg';
                    }

                    this.$fullscreenImgHighRes!.onload = () => {
                        if (this.selectedId === id) {
                            this.$fullscreenImgHighRes!.classList.add('loaded');
                            this.$fullscreenSpinner!.style.display = 'none';
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
            this.$fullscreenImgPlaceholder.src = bestUrl;
            this.$fullscreenImgPlaceholder.style.display = 'block';
        } else {
            this.$fullscreenImgPlaceholder.style.display = 'none';
        }
        
        requestFullRes();
    }

    private toggleFullscreen() {
        if (this.isFullscreen) {
            this.$fullscreenOverlay?.remove();
            this.$fullscreenOverlay = null;
            this.$fullscreenImgPlaceholder = null;
            this.$fullscreenImgHighRes = null;
            this.$fullscreenSpinner = null;
            this.isFullscreen = false;
            
            // Refresh loupe if we are returning to it
            if (this.isLoupeMode && this.selectedId) {
                this.renderLoupe();
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
        this.$fullscreenSpinner = spinner;

        const imgP = document.createElement('img'); 
        imgP.className = 'fullscreen-img placeholder';
        overlay.appendChild(imgP);
        this.$fullscreenImgPlaceholder = imgP;

        const imgH = document.createElement('img');
        imgH.className = 'fullscreen-img highres';
        overlay.appendChild(imgH);
        this.$fullscreenImgHighRes = imgH;
        
        document.body.appendChild(overlay);
        this.$fullscreenOverlay = overlay;
        
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

    renderMetadata() {
        if (!this.$metadataEl || !this.selectedId) return;
        const photo = this.photoMap.get(this.selectedId) || null;
        let model = '';
        for (const group of this.selectedMetadata) {
            if (group.items['Model']) { model = group.items['Model']; break; }
            if (group.items['Camera Model Name']) { model = group.items['Camera Model Name']; break; }
        }
        const thumbUrl = model ? this.cameraThumbCache.get(model.toString()) : undefined;

        const props = {
            photo,
            metadata: this.selectedMetadata,
            cameraThumbUrl: thumbUrl,
            onSearch: (tag: string, val: string) => hub.pub(ps.SEARCH_TRIGGERED, { tag, value: val })
        };

        this.metadataVNode = patch(this.metadataVNode || this.$metadataEl, MetadataPanel(props));
        this.$metadataEl = (this.metadataVNode as VNode).elm as HTMLElement;
    }

    // REQ-WFE-00013
    async loadMetadata(id: string) {
        if (!id) return;
        const photo = this.photoMap.get(id);
        if (!photo) return;

        try {
            const meta = await Api.api_metadata({ id });
            this.selectedMetadata = meta;
            if (this.isLoupeMode) this.updateLoupeOverlay(id);

            // Update hash if provided (lazy computed)
            let fileHash = '';
            for (const group of meta) {
                if (group.items['FileHash']) {
                    fileHash = group.items['FileHash'];
                    break;
                }
            }

            if (fileHash) {
                const p = this.photoMap.get(id);
                if (p) p.hash = fileHash;
            }

            // Restore View Preferences
            let viewPrefs = '';
            for (const group of meta) {
                if (group.items['ViewPreferences']) {
                    viewPrefs = group.items['ViewPreferences'];
                    break;
                }
            }

            if (viewPrefs && this.isLoupeMode && this.setViewTransform) {
                try {
                    const p = JSON.parse(viewPrefs);
                    this.setViewTransform(p.rotation, p.zoom, p.panL, p.panT);
                } catch (e) { console.error('Failed to restore view prefs', e); }
            }

            // Initial render without camera thumb
            this.renderMetadata();

            // Camera Thumbnail loading
            let model = '';
            for (const group of meta) {
                if (group.items['Model']) { model = group.items['Model']; break; }
                if (group.items['Camera Model Name']) { model = group.items['Camera Model Name']; break; }
            }
            
            if (model && !this.cameraThumbCache.has(model)) {
                const thumbUrl = `/api/camera/thumbnail/${encodeURIComponent(model)}`;
                const img = new Image();
                img.onload = () => {
                    this.cameraThumbCache.set(model, thumbUrl);
                    this.renderMetadata();
                };
                img.onerror = () => {
                    this.cameraThumbCache.set(model, '');
                    this.renderMetadata();
                };
                img.src = thumbUrl;
            } else {
                this.renderMetadata();
            }

        } catch (err) { 
            console.error(err);
        }
    }

    // REQ-WFE-00014
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

    // REQ-WFE-00014
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

        // Mode-switching and help should always work
        if (key === 'g') {
            if (this.isFullscreen) this.toggleFullscreen();
            hub.pub(ps.VIEW_MODE_CHANGED, { mode: 'grid' });
            return;
        }
        if (key === 'l' || key === 'enter' || e.key === ' ') {
            if (this.isLibraryMode && (key === 'enter' || key === ' ')) return; // Don't switch from library on space/enter
            e.preventDefault();
            if (this.isFullscreen) this.toggleFullscreen();
            hub.pub(ps.VIEW_MODE_CHANGED, { mode: 'loupe', id: this.selectedId || undefined });
            return;
        }
        if (key === '?' || key === '/') { 
            if (key === '?' || (key === '/' && e.shiftKey)) { 
                e.preventDefault(); 
                hub.pub(ps.SHORTCUTS_SHOW, {}); 
                return;
            } 
        }

        // If in Library mode, disable all other hotkeys
        if (this.isLibraryMode) return;
        
        if (key === 'escape') {
            if (this.isFullscreen) this.toggleFullscreen();
        }
        
        if (key === 'f') {
            e.preventDefault();
            this.toggleFullscreen();
        }
        if (key === 'h') {
            const targets = this.selectedIds.size > 0 ? Array.from(this.selectedIds) : (this.selectedId ? [this.selectedId] : []);
            targets.forEach(id => this.toggleHide(id));
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
            const targets = this.selectedIds.size > 0 ? Array.from(this.selectedIds) : (this.selectedId ? [this.selectedId] : []);
            const photos = this.photos.filter(p => targets.includes(p.id));
            photos.forEach(p => server.togglePick(p));
        }
        if (key >= '0' && key <= '5') {
            const rating = parseInt(key);
            const targets = this.selectedIds.size > 0 ? Array.from(this.selectedIds) : (this.selectedId ? [this.selectedId] : []);
            const photos = this.photos.filter(p => targets.includes(p.id));
            photos.forEach(p => server.setRating(p, rating));
        }

        if (key === '[') {
            const targets = this.selectedIds.size > 0 ? Array.from(this.selectedIds) : (this.selectedId ? [this.selectedId] : []);
            targets.forEach(id => {
                const current = this.rotationMap.get(id) || 0;
                hub.pub(ps.PHOTO_ROTATED, { id, rotation: current - 90 });
            });
        }
        if (key === ']') {
            const targets = this.selectedIds.size > 0 ? Array.from(this.selectedIds) : (this.selectedId ? [this.selectedId] : []);
            targets.forEach(id => {
                const current = this.rotationMap.get(id) || 0;
                hub.pub(ps.PHOTO_ROTATED, { id, rotation: current + 90 });
            });
        }

        if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(e.key.toLowerCase())) {
            e.preventDefault();
            this.navigate(e.key, e.shiftKey);
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

    private navigate(key: string, shift: boolean = false) {
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
            // If shift is pressed, we treat it as standard range selection from anchor
            // unless in Loupe mode where we enforce single selection.
            const mods = { shift: shift, ctrl: false }; 
            hub.pub(ps.PHOTO_SELECTED, { id: target.id, photo: target, modifiers: mods });
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
        
        