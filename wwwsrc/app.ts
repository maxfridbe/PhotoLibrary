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

type Photo = Res.PhotoResponse;
type MetadataItem = Res.MetadataItemResponse;
type RootPath = Res.RootPathResponse;
type Collection = Res.CollectionResponse;
type Stats = Res.StatsResponse;

type SortOption = 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc' | 'rating-desc' | 'size-desc';

class App {
    public layout: any;
    private themeManager: ThemeManager;
    public libraryManager: LibraryManager;

    private allPhotosFlat: Photo[] = []; 
    public photos: Photo[] = []; // Processed list
    
    private photoMap: Map<string, Photo> = new Map();
    private roots: RootPath[] = [];
    public userCollections: Collection[] = [];
    public stats: Stats = { totalCount: 0, pickedCount: 0, ratingCounts: [0,0,0,0,0] };
    public totalPhotos = 0;
    
    private cardCache: Map<string, HTMLElement> = new Map();
    private imageUrlCache: Map<string, string> = new Map();

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

    private readonly rowHeight = 230; 
    private readonly minCardWidth = 210; 
    private cols = 1;
    private visibleRange = { start: 0, end: 0 };
    private isLoadingChunk = new Set<number>();

    public isLoupeMode = false;
    public isLibraryMode = false;
    public isIndexing = false;
    private overlayFormat = '{Filename}\n{Takendate}\n{Takentime}';
    private loupeOverlayEl: HTMLElement | null = null;
    
    // Connection State
    private disconnectedAt: number | null = null;
    private isConnected: boolean = false;
    private isConnecting: boolean = false;
    private statusInterval: any = null;

    // Fullscreen state
    private isFullscreen: boolean = false;
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

    private metaTitleEl: HTMLHeadingElement | null = null;
    private metaGroups: Map<string, { container: HTMLElement, rows: Map<string, HTMLElement> }> = new Map();

    private importedBatchCount = 0;
    private importedBatchTimer: any = null;
    private folderProgress: Map<string, { processed: number, total: number }> = new Map();

    constructor() {
        this.themeManager = new ThemeManager();
        this.libraryManager = new LibraryManager();

        hub.sub('folder.progress', (data) => {
            this.folderProgress.set(data.rootId, { processed: data.processed, total: data.total });
            this.refreshDirectories(); // Trigger tree re-render
        });

        hub.sub('folder.finished', (data) => {
            this.folderProgress.delete(data.rootId);
            this.refreshDirectories();
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
        hub.sub('photo.selected', (data) => {
            this.selectedId = data.id;
            this.updateSelectionUI(data.id);
            this.loadMetadata(data.id);
            
            if (this.isFullscreen) {
                this.updateFullscreenImage(data.id);
            } else if (this.isLoupeMode) {
                this.loadMainPreview(data.id);
                this.updateLoupeOverlay(data.id);
            } else {
                this.scrollToPhoto(data.id);
            }
            
            if (this.workspaceEl) this.workspaceEl.focus();
        });

        hub.sub('view.mode.changed', (data) => {
            this.isLoupeMode = data.mode === 'loupe';
            this.updateViewModeUI();
            if (data.mode === 'loupe' && data.id) {
                hub.pub('photo.selected', { id: data.id, photo: this.photoMap.get(data.id)! });
                this.updateLoupeOverlay(data.id);
            }
        });

        hub.sub('photo.updated', (data) => {
            this.handlePhotoUpdate(data.photo);
        });

        hub.subPattern('photo.picked.*', () => this.refreshStatsOnly());
        hub.subPattern('photo.starred.*', () => this.refreshStatsOnly());

        hub.sub('search.triggered', (data) => this.searchPhotos(data.tag, data.value));
        hub.sub('shortcuts.show', () => document.getElementById('shortcuts-modal')?.classList.add('active'));

        hub.sub('ui.layout.changed', () => this.updateVirtualGrid());
        
        hub.sub('connection.changed', (data) => {
            this.isConnected = data.connected;
            this.isConnecting = data.connecting;
            if (this.isConnected) {
                this.disconnectedAt = null;
            } else if (this.disconnectedAt === null) {
                this.disconnectedAt = Date.now();
            }
            this.updateStatusUI();
        });

        hub.sub('ui.notification', (data) => this.showNotification(data.message, data.type));

        hub.sub('library.updated', () => {
            this.isIndexing = false;
            this.loadData();
            this.refreshDirectories();
            if (this.isLibraryMode) this.libraryManager.loadLibraryInfo();
        });

        hub.sub('photo.imported', (data) => {
            // Live update counts in the tree
            if (data.rootId) {
                const node = this.roots.find(r => r.id === data.rootId);
                if (node) {
                    node.imageCount++;
                    this.refreshDirectories(); // Re-render tree with new counts
                }
            }

            if (this.isIndexing) {
                // Skip heavy API calls during bulk indexing
                return;
            }
            
            this.refreshStatsOnly();
            this.refreshDirectories();
            if (this.isLibraryMode) this.libraryManager.loadLibraryInfo();
            
            this.importedBatchCount++;
            if (this.importedBatchTimer) clearTimeout(this.importedBatchTimer);
            this.importedBatchTimer = setTimeout(() => {
                this.showNotification(`Finished importing ${this.importedBatchCount} photos`, "success");
                this.importedBatchCount = 0;
            }, 2000);
        });

        hub.sub('preview.generated', (data) => {
            let prog = this.folderProgress.get(data.rootId);
            const root = this.roots.find(r => r.id === data.rootId);
            const total = root ? root.imageCount : 100; // fallback

            if (!prog) {
                prog = { processed: 1, total };
                this.folderProgress.set(data.rootId, prog);
            } else {
                prog.processed++;
                if (prog.total < prog.processed) prog.total = prog.processed;
            }

            // If we've hit the total, clear it after a short delay
            if (prog.processed >= prog.total) {
                setTimeout(() => {
                    this.folderProgress.delete(data.rootId);
                    this.updateFolderProgressUI(data.rootId);
                }, 3000);
            }

            this.updateFolderProgressUI(data.rootId);
        });

        hub.sub('folder.progress', (data) => {
            this.folderProgress.set(data.rootId, { processed: data.processed, total: data.total });
            this.updateFolderProgressUI(data.rootId);
        });

        hub.sub('folder.finished', (data) => {
            this.folderProgress.delete(data.rootId);
            this.updateFolderProgressUI(data.rootId);
        });
    }

    private startStatusTimer() {
        this.statusInterval = setInterval(() => {
            if (this.disconnectedAt !== null) {
                this.updateStatusUI();
            }
        }, 1000);
    }

    public toggleStacking(enabled: boolean) {
        this.stackingEnabled = enabled;
        this.processUIStacks();
    }

    public setSort(sort: SortOption) {
        this.sortBy = sort;
        this.processUIStacks();
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
            this.updatePhotoCardUI(rep);
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
                        if (ext === 'ARW') return 0;
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

    async loadData() {
        try {
            const [roots, colls, stats] = await Promise.all([
                Api.api_directories({}),
                Api.api_collections_list({}),
                Api.api_stats({})
            ]);
            this.roots = roots;
            this.userCollections = colls;
            this.stats = stats;
            await this.refreshPhotos();
        } catch (e) { console.error("Load failed", e); }
    }

    async refreshPhotos() {
        this.allPhotosFlat = [];
        this.photos = [];
        this.cardCache.clear();
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
        this.allPhotosFlat.forEach(p => this.photoMap.set(p.id, p));
        
        this.stats = stats;
        this.renderLibrary();
        this.processUIStacks();

        if (this.photos.length > 0) {
            hub.pub('photo.selected', { id: this.photos[0].id, photo: this.photos[0] });
        }
    }

    initLayout() {
        const config = {
            settings: { showPopoutIcon: false },
            content: [{
                type: 'row',
                content: [
                    { type: 'component', componentName: 'library', width: 20, title: 'Library' },
                    { type: 'component', componentName: 'workspace', width: 60, title: 'Photos' },
                    { type: 'component', componentName: 'metadata', width: 20, title: 'Metadata' }
                ]
            }]
        };
        this.layout = new GoldenLayout(config, '#layout-container');
        const self = this;
        this.layout.registerComponent('library', function(container: any) {
            self.libraryEl = document.createElement('div');
            self.libraryEl.className = 'tree-view gl-component';
            container.getElement().append(self.libraryEl);
            if (self.photos.length > 0) self.renderLibrary();
        });
        this.layout.registerComponent('workspace', function(container: any) {
            self.workspaceEl = document.createElement('div');
            self.workspaceEl.className = 'gl-component';
            self.workspaceEl.style.overflow = 'hidden';
            
            const header = document.createElement('div');
            header.id = 'grid-header';
            header.className = 'grid-header';
            const headerText = document.createElement('span');
            headerText.id = 'header-text';
            headerText.textContent = 'All Photos';
            
            const headerRight = document.createElement('div');
            headerRight.style.display = 'flex';
            headerRight.style.alignItems = 'center';
            headerRight.style.gap = '15px';

            const sortLabel = document.createElement('label');
            sortLabel.className = 'control-item';
            sortLabel.textContent = 'Sort: ';
            const sortSelect = document.createElement('select');
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
            stackLabel.title = 'Stack JPG/ARW files with same name';
            const stackCheck = document.createElement('input');
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
            
            headerRight.appendChild(sortLabel);
            headerRight.appendChild(stackLabel);
            headerRight.appendChild(headerCount);

            header.appendChild(headerText);
            header.appendChild(headerRight);
            self.workspaceEl.appendChild(header);

            const gridContainer = document.createElement('div');
            gridContainer.id = 'grid-container';
            gridContainer.style.flex = '1';
            gridContainer.style.overflowY = 'auto';
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
            
            previewArea.appendChild(spinner);
            previewArea.appendChild(overlay);
            previewArea.appendChild(imgP);
            previewArea.appendChild(imgH);
            
            const resizer = document.createElement('div');
            resizer.className = 'filmstrip-resizer';
            
            const filmstrip = document.createElement('div');
            filmstrip.id = 'filmstrip';
            filmstrip.className = 'filmstrip';
            
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
            self.loupePreviewPlaceholder = imgP as HTMLImageElement;
            self.mainPreview = imgH as HTMLImageElement;
            self.previewSpinner = spinner;

            gridContainer.onscroll = () => self.updateVirtualGrid();
            
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
            hub.pub('ui.layout.changed', {}); 
        });
        this.layout.on('stateChanged', () => hub.pub('ui.layout.changed', {}));
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

    private syncCardData(card: HTMLElement, photo: Photo) {
        const pBtn = card.querySelector('.pick-btn');
        if (pBtn) { if (photo.isPicked) pBtn.classList.add('picked'); else pBtn.classList.remove('picked'); }
        const stars = card.querySelector('.stars');
        if (stars) {
            const el = stars as HTMLElement;
            el.textContent = '\u2605'.repeat(photo.rating) || '\u2606\u2606\u2606\u2606\u2606';
            if (photo.rating > 0) el.classList.add('has-rating'); else el.classList.remove('has-rating');
        }
        
        const nameEl = card.querySelector('.filename');
        if (nameEl) {
            let displayName = photo.fileName || '';
            if (photo.stackExtensions && (this.stackingEnabled || photo.stackCount > 1)) {
                const extIdx = displayName.lastIndexOf('.');
                const base = extIdx > 0 ? displayName.substring(0, extIdx) : displayName;
                displayName = `${base} (${photo.stackExtensions})`;
            }
            nameEl.textContent = displayName;
        }

        if (photo.stackCount > 1 && this.stackingEnabled) {
            card.classList.add('is-stacked');
            let badge = card.querySelector('.stack-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'stack-badge';
                card.appendChild(badge);
            }
            badge.textContent = photo.stackCount.toString();
        } else {
            card.classList.remove('is-stacked');
            card.querySelector('.stack-badge')?.remove();
        }
    }

    private updatePhotoCardUI(photo: Photo) {
        const cached = this.cardCache.get(photo.id);
        if (cached) this.syncCardData(cached, photo);
        
        const inDom = this.workspaceEl?.querySelectorAll(`.card[data-id="${photo.id}"]`);
        inDom?.forEach(card => this.syncCardData(card as HTMLElement, photo));
    }

    updateVirtualGrid(force: boolean = false) {
        if (!this.gridView || !this.workspaceEl || this.isLoupeMode) return;
        const gridContainer = this.gridView.parentElement as HTMLElement;
        const containerWidth = gridContainer.clientWidth - 20;
        this.cols = Math.max(1, Math.floor(containerWidth / this.minCardWidth));
        const rowCount = Math.ceil(this.totalPhotos / this.cols);
        const totalHeight = rowCount * this.rowHeight;
        this.scrollSentinel!.style.height = totalHeight + 'px';
        const scrollTop = gridContainer.scrollTop;
        const viewHeight = gridContainer.clientHeight;
        const startRow = Math.floor(scrollTop / this.rowHeight);
        const endIndex = Math.min(this.totalPhotos, Math.ceil((scrollTop + viewHeight) / this.rowHeight + 1) * this.cols);
        const startIndex = Math.max(0, startRow * this.cols);
        if (force || startIndex !== this.visibleRange.start || endIndex !== this.visibleRange.end) {
            this.visibleRange = { start: startIndex, end: endIndex };
            this.renderVisiblePhotos();
        }
    }

    renderVisiblePhotos() {
        if (!this.gridView) return;
        const startRow = Math.floor(this.visibleRange.start / this.cols);
        this.gridView.style.transform = `translateY(${startRow * this.rowHeight}px)`;

        const fragment = document.createDocumentFragment();
        for (let i = this.visibleRange.start; i < this.visibleRange.end; i++) {
            const photo = this.photos[i];
            if (photo) {
                let card = this.cardCache.get(photo.id);
                if (!card) {
                    card = this.createCard(photo, 'grid');
                    this.cardCache.set(photo.id, card);
                } else {
                    this.syncCardData(card, photo);
                }
                fragment.appendChild(card);
            } else {
                const placeholder = document.createElement('div');
                placeholder.className = 'card placeholder';
                placeholder.style.height = (this.rowHeight - 10) + 'px';
                const cont = document.createElement('div');
                cont.className = 'img-container';
                const spin = document.createElement('div');
                spin.className = 'spinner';
                cont.appendChild(spin);
                placeholder.appendChild(cont);
                fragment.appendChild(placeholder);
            }
        }
        this.gridView.innerHTML = '';
        this.gridView.appendChild(fragment);
    }

    renderLibrary() {
        if (!this.libraryEl) return;
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
        searchInput.className = 'search-input';
        searchInput.placeholder = 'Tag search...';
        searchInput.onkeydown = (e) => { if (e.key === 'Enter') hub.pub('search.triggered', { tag: 'FileName', value: searchInput.value }); };
        searchBox.appendChild(searchInput);
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

        if (!prog) {
            el.innerHTML = '';
            return;
        }

        const percent = Math.round((prog.processed / prog.total) * 100);
        el.innerHTML = `
            <div style="width: 60px; height: 8px; background: var(--bg-input); border-radius: 4px; overflow: hidden; margin: 0 0.5em;" title="${prog.processed} / ${prog.total}">
                <div style="width: ${percent}%; height: 100%; background: var(--accent); transition: width 0.2s ease;"></div>
            </div>
            <span class="cancel-task" style="cursor: pointer; padding: 0 4px; color: var(--text-muted);" title="Cancel">&times;</span>
        `;
        
        el.querySelector('.cancel-task')?.addEventListener('click', (e) => {
            e.stopPropagation();
            Api.api_library_cancel_task({ id: `thumbnails-${rootId}` });
        });
    }

    private renderFolderTree(container: HTMLElement) {
        const map = new Map<string, { node: RootPath, children: any[] }>();
        this.roots.forEach(r => map.set(r.id, { node: r, children: [] }));
        
        const roots: any[] = [];
        this.roots.forEach(r => { 
            if (r.parentId && map.has(r.parentId)) map.get(r.parentId)!.children.push(map.get(r.id)); 
            else roots.push(map.get(r.id)); 
        });

        const renderNode = (item: any, target: HTMLElement) => {
            const el = document.createElement('div');
            el.className = 'tree-item folder-tree-item' + (this.selectedRootId === item.node.id ? ' selected' : '');
            
            const toggle = document.createElement('span');
            toggle.className = 'tree-toggle';
            toggle.style.width = '1.2em';
            toggle.style.display = 'inline-block';
            toggle.style.textAlign = 'center';
            toggle.style.cursor = 'pointer';
            toggle.innerHTML = item.children.length > 0 ? '&#9662;' : '&nbsp;';

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
            childrenContainer.style.display = 'block';
            target.appendChild(childrenContainer);

            el.onclick = () => this.setFilter('all', 0, item.node.id);
            el.oncontextmenu = (e) => {
                e.preventDefault();
                this.showFolderContextMenu(e, item.node.id);
            };

            if (item.children.length > 0) {
                toggle.onclick = (e) => {
                    e.stopPropagation();
                    if (childrenContainer.style.display === 'none') {
                        childrenContainer.style.display = 'block';
                        toggle.innerHTML = '&#9662;';
                    } else {
                        childrenContainer.style.display = 'none';
                        toggle.innerHTML = '&#9656;';
                    }
                };

                item.children.forEach((c: any) => renderNode(c, childrenContainer));
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
        this.filterType = type;
        this.filterRating = rating;
        this.selectedRootId = rootId;
        this.selectedCollectionId = null;
        this.refreshPhotos();
    }

    async setCollectionFilter(c: Collection) {
        this.filterType = 'collection';
        this.selectedCollectionId = c.id;
        this.selectedRootId = null;
        this.collectionFiles = await Api.api_collections_get_files({ id: c.id });
        this.refreshPhotos();
    }

    setupContextMenu() { document.addEventListener('click', () => { const menu = document.getElementById('context-menu'); if (menu) menu.style.display = 'none'; }); }

    showFolderContextMenu(e: MouseEvent, rootId: string) {
        const menu = document.getElementById('context-menu')!;
        menu.innerHTML = '';
        const addItem = (text: string, cb: () => void) => {
            const el = document.createElement('div'); el.className = 'context-menu-item'; el.textContent = text; el.onclick = cb; menu.appendChild(el);
        };

        addItem('Generate Thumbnails (This Folder)', () => {
            Api.api_library_generate_thumbnails({ rootId, recursive: false });
        });
        addItem('Generate Thumbnails (Recursive)', () => {
            Api.api_library_generate_thumbnails({ rootId, recursive: true });
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
        hub.pub('ui.notification', { message: 'Preparing download...', type: 'info' });
        
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
                hub.pub('ui.notification', { message: 'Download started', type: 'success' });
            } else {
                hub.pub('ui.notification', { message: 'Failed to prepare export', type: 'error' });
            }
        } catch (e) {
            console.error(e);
            hub.pub('ui.notification', { message: 'Error starting download', type: 'error' });
        }
    }

    async clearAllPicked() { await Api.api_picked_clear({}); this.refreshPhotos(); hub.pub('ui.notification', { message: 'Picked photos cleared', type: 'info' }); }

    async storePickedToCollection(id: string | null) {
        const pickedIds = await Api.api_picked_ids({});
        if (pickedIds.length === 0) return;
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
        await Api.api_collections_add_files({ collectionId: id!, fileIds: pickedIds });
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
        this.searchResultIds = await Api.api_search({ tag, value });
        this.searchTitle = `${tag}: ${value}`;
        this.setFilter('search');
    }

    public getFilteredPhotos(): Photo[] { return this.photos; }

    renderGrid() {
        this.updateVirtualGrid(true);
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
        loadedPhotos.forEach(p => this.filmstrip!.appendChild(this.createCard(p, 'filmstrip')));
        if (this.selectedId) {
            const el = this.filmstrip.querySelector(`.card[data-id="${this.selectedId}"]`);
            if (el) el.scrollIntoView({ behavior: 'auto', inline: 'center' });
        }
    }

    createCard(p: Photo, type: 'grid' | 'filmstrip'): HTMLElement {
        const card = document.createElement('div');
        card.className = 'card';
        if (this.selectedId === p.id) card.classList.add('selected');
        card.dataset.id = p.id;
        
        const imgContainer = document.createElement('div');
        imgContainer.className = 'img-container';
        const img = document.createElement('img');
        imgContainer.appendChild(img);
        this.lazyLoadImage(p.id, img, 300);
        card.appendChild(imgContainer);
        
        const info = document.createElement('div');
        info.className = 'info';
        
        const top = document.createElement('div');
        top.className = 'info-top';
        const name = document.createElement('span'); name.className = 'filename'; 
        top.appendChild(name);
        
        const pick = document.createElement('span'); pick.className = 'pick-btn' + (p.isPicked ? ' picked' : ''); pick.textContent = '\u2691';
        pick.onclick = (e) => { e.stopPropagation(); server.togglePick(p); };
        top.appendChild(pick);
        
        const mid = document.createElement('div');
        mid.className = 'info-mid';
        mid.textContent = new Date(p.createdAt).toISOString().split('T')[0];
        
        const bottom = document.createElement('div');
        bottom.className = 'info-bottom';
        const stars = document.createElement('span'); stars.className = 'stars' + (p.rating > 0 ? ' has-rating' : '');
        stars.textContent = '\u2605'.repeat(p.rating) || '\u2606\u2606\u2606\u2606\u2606';
        bottom.appendChild(stars);
        
        info.appendChild(top); 
        info.appendChild(mid);
        info.appendChild(bottom);
        card.appendChild(info);
        
        if (type === 'grid') {
            card.addEventListener('dblclick', () => hub.pub('view.mode.changed', { mode: 'loupe', id: p.id }));
        }
        card.addEventListener('click', () => hub.pub('photo.selected', { id: p.id, photo: p }));
        
        this.syncCardData(card, p); 
        return card;
    }

    lazyLoadImage(id: string, img: HTMLImageElement, size: number) {
        const cacheKey = id + '-' + size;
        if (this.imageUrlCache.has(cacheKey)) {
            img.src = this.imageUrlCache.get(cacheKey)!;
            img.parentElement?.classList.add('loaded');
            return;
        }

        const target = img.parentElement || img;
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    server.requestImage(id, size).then((blob: Blob) => {
                        const url = URL.createObjectURL(blob);
                        this.imageUrlCache.set(cacheKey, url);
                        img.onload = () => img.parentElement?.classList.add('loaded');
                        img.src = url;
                    });
                    observer.disconnect();
                }
            });
        });
        observer.observe(target);
    }

    selectPhoto(id: string) {
        if (this.selectedId === id) return;
        this.selectedId = id;
        this.updateSelectionUI(id);
        this.loadMetadata(id);
        if (this.isFullscreen) this.updateFullscreenImage(id);
        else if (this.isLoupeMode) this.loadMainPreview(id);
    }

    scrollToPhoto(id: string) {
        const index = this.photos.findIndex(p => p?.id === id);
        if (index === -1) return;
        const row = Math.floor(index / this.cols);
        const gridContainer = this.gridView?.parentElement as HTMLElement;
        if (!gridContainer) return;

        const currentScroll = gridContainer.scrollTop;
        const viewHeight = gridContainer.clientHeight;
        const targetTop = row * this.rowHeight;
        
        if (targetTop < currentScroll || targetTop + this.rowHeight > currentScroll + viewHeight) {
            gridContainer.scrollTo({
                top: targetTop - (viewHeight / 2) + (this.rowHeight / 2),
                behavior: 'smooth'
            });
        }
    }

    enterLoupeMode(id: string) {
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
        if (this.selectedId) this.scrollToPhoto(this.selectedId);
        this.updateVirtualGrid(true);
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
                this.updateVirtualGrid(true);
            }
        }
    }

    loadMainPreview(id: string) {
        if (!this.mainPreview || !this.loupePreviewPlaceholder || !this.previewSpinner) return;
        
        this.mainPreview.classList.remove('loaded');
        this.previewSpinner.style.display = 'block';
        
        const lowResKey = id + '-300';
        const highResKey = id + '-1024';

        const requestHighRes = () => {
            server.requestImage(id, 1024).then((blob: Blob) => {
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
                }
            });
        };

        if (this.imageUrlCache.has(highResKey)) {
            this.mainPreview.src = this.imageUrlCache.get(highResKey)!;
            this.mainPreview.classList.add('loaded');
            this.previewSpinner.style.display = 'none';
            this.loupePreviewPlaceholder.style.display = 'none';
            return;
        }

        if (this.imageUrlCache.has(lowResKey)) {
            this.loupePreviewPlaceholder.src = this.imageUrlCache.get(lowResKey)!;
            this.loupePreviewPlaceholder.style.display = 'block';
            requestHighRes();
        } else {
            this.loupePreviewPlaceholder.style.display = 'none';
            server.requestImage(id, 300).then((blob: Blob) => {
                const url = URL.createObjectURL(blob);
                this.imageUrlCache.set(lowResKey, url);
                if (this.selectedId === id && this.isLoupeMode) {
                    this.loupePreviewPlaceholder!.src = url;
                    this.loupePreviewPlaceholder!.style.display = 'block';
                    requestHighRes();
                }
            });
        }
    }

    private updateFullscreenImage(id: string) {
        if (!this.fullscreenImgPlaceholder || !this.fullscreenImgHighRes || !this.fullscreenSpinner || !this.fullscreenOverlay) return;
        
        this.fullscreenImgHighRes.classList.remove('loaded');
        this.fullscreenSpinner.style.display = 'block';
        
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
                    searchBtn.onclick = () => hub.pub('search.triggered', { tag: m.tag!, value: m.value! });
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

    private handleKey(e: KeyboardEvent) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
        
        const key = e.key.toLowerCase();
        if (key === 'escape') {
            if (this.isFullscreen) this.toggleFullscreen();
        }
        if (key === 'g') {
            if (this.isFullscreen) this.toggleFullscreen();
            hub.pub('view.mode.changed', { mode: 'grid' });
        }
        if (key === 'l' || key === 'enter' || e.key === ' ') {
            e.preventDefault();
            if (this.isFullscreen) this.toggleFullscreen();
            hub.pub('view.mode.changed', { mode: 'loupe', id: this.selectedId || undefined });
        }
        if (key === 'f') {
            e.preventDefault();
            this.toggleFullscreen();
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
        if (key === '?' || key === '/') { if (key === '?' || (key === '/' && e.shiftKey)) { e.preventDefault(); hub.pub('shortcuts.show', {}); } }
        
        if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(e.key.toLowerCase())) {
            e.preventDefault();
            this.navigate(e.key);
        }
    }

    private navigate(key: string) {
        if (this.photos.length === 0) return;
        
        let index = this.selectedId ? this.photos.findIndex(p => p?.id === this.selectedId) : -1;
        
        if (key === 'ArrowRight') index++; 
        else if (key === 'ArrowLeft') index--;
        else if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (this.isLoupeMode || this.isFullscreen) { if (key === 'ArrowDown') index++; else index--; }
            else { if (key === 'ArrowDown') index += this.cols; else index -= this.cols; }
        }
        
        index = Math.max(0, Math.min(this.photos.length - 1, index));
        const target = this.photos[index];
        if (target) {
            hub.pub('photo.selected', { id: target.id, photo: target });
            // Always scroll to photo in background to keep grid in sync
            this.scrollToPhoto(target.id);
        }
    }

    private setupGlobalKeyboard() {
        document.addEventListener('keydown', (e) => this.handleKey(e));
    }
}

const app = new App();
(window as any).app = app;
hub.pub('ui.layout.changed', {}); hub.pub('connection.changed', { connected: false, connecting: true });