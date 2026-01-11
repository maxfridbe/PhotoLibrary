declare var GoldenLayout: any;
declare var $: any;

import * as Req from './Requests.generated.js';
import * as Res from './Responses.generated.js';
import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';

type Photo = Res.PhotoResponse;
type MetadataItem = Res.MetadataItemResponse;
type RootPath = Res.RootPathResponse;
type Collection = Res.CollectionResponse;
type Stats = Res.StatsResponse;
type ImageRequest = Req.ImageRequest;

class App {
    public layout: any;
    private ws: WebSocket | null = null;
    private requestMap: Map<number, (blob: Blob) => void> = new Map();
    private nextRequestId = 1;
    private isConnected = false;
    private pendingRequests: ImageRequest[] = [];

    public photos: (Photo | null)[] = []; 
    private photoMap: Map<string, Photo> = new Map();
    private roots: RootPath[] = [];
    public userCollections: Collection[] = [];
    public stats: Stats = { pickedCount: 0, ratingCounts: [0,0,0,0,0] };
    public totalPhotos = 0;
    
    public selectedId: string | null = null;
    public selectedRootId: string | null = null;
    public selectedCollectionId: string | null = null;
    public filterType: 'all' | 'picked' | 'rating' | 'search' | 'collection' = 'all';
    public filterRating: number = 0;
    
    public searchResultIds: string[] = [];
    public searchTitle: string = '';
    public collectionFiles: string[] = [];

    private readonly rowHeight = 230; 
    private readonly minCardWidth = 210; 
    private cols = 1;
    private visibleRange = { start: 0, end: 0 };
    private isLoadingChunk = new Set<number>();

    public isLoupeMode = false;
    private reconnectAttempts = 0;
    private readonly maxReconnectDelay = 256000;

    public libraryEl: HTMLElement | null = null;
    public workspaceEl: HTMLElement | null = null;
    public metadataEl: HTMLElement | null = null;
    public gridHeader: HTMLElement | null = null;
    public gridView: HTMLElement | null = null;
    public scrollSentinel: HTMLElement | null = null;
    public loupeView: HTMLElement | null = null;
    public filmstrip: HTMLElement | null = null;
    public mainPreview: HTMLImageElement | null = null;
    public previewSpinner: HTMLElement | null = null;

    constructor() {
        this.initLayout();
        this.connectWs();
        this.loadData();
        this.setupGlobalKeyboard();
        this.setupContextMenu();
        this.initPubSub();
    }

    private initPubSub() {
        hub.sub('photo.selected', (data) => {
            this.selectedId = data.id;
            this.updateSelectionUI(data.id);
            this.loadMetadata(data.id);
            if (this.isLoupeMode) this.loadMainPreview(data.id);
        });

        hub.sub('view.mode.changed', (data) => {
            this.isLoupeMode = data.mode === 'loupe';
            this.updateViewModeUI();
            if (data.mode === 'loupe' && data.id) {
                hub.pub('photo.selected', { id: data.id, photo: this.photoMap.get(data.id)! });
            }
        });

        hub.sub('photo.updated', (data) => {
            this.photoMap.set(data.id, data.photo);
            const idx = this.photos.findIndex(p => p?.id === data.id);
            if (idx !== -1) this.photos[idx] = data.photo;
            this.updatePhotoCardUI(data.photo);
            if (this.selectedId === data.id) this.loadMetadata(data.id);
        });

        hub.subPattern('photo.picked.*', () => this.refreshStatsAndLibrary());
        hub.subPattern('photo.starred.*', () => this.refreshStatsAndLibrary());

        hub.sub('search.triggered', (data) => this.searchPhotos(data.tag, data.value));
        hub.sub('shortcuts.show', () => document.getElementById('shortcuts-modal')?.classList.add('active'));

        hub.sub('ui.layout.changed', () => this.updateVirtualGrid());
        hub.sub('connection.changed', (data) => this.updateStatusUI(data.connected, data.connecting));
        hub.sub('ui.notification', (data) => this.showNotification(data.message, data.type));
    }

    private showNotification(message: string, type: 'info' | 'error' | 'success') {
        const container = document.getElementById('notifications');
        if (!container) return;
        const el = document.createElement('div');
        el.style.padding = '10px 20px';
        el.style.borderRadius = '4px';
        el.style.color = '#fff';
        el.style.fontSize = '0.9em';
        el.style.boxShadow = '0 4px 10px rgba(0,0,0,0.3)';
        el.style.background = type === 'error' ? '#d32f2f' : (type === 'success' ? '#388e3c' : '#1976d2');
        el.innerText = message;
        container.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transition = 'opacity 0.5s';
            setTimeout(() => el.remove(), 500);
        }, 3000);
    }

    private updateStatusUI(connected: boolean, connecting: boolean = false) {
        const el = document.getElementById('connection-status');
        if (el) {
            if (connecting) {
                el.innerHTML = '<span class="spinner" style="display:inline-block; width:10px; height:10px; vertical-align:middle; margin-right:5px;"></span> Connecting...';
                el.style.color = '#aaa';
            } else if (connected) {
                el.innerText = 'Connected';
                el.style.color = '#0f0';
            } else {
                el.innerText = 'Disconnected';
                el.style.color = '#f00';
            }
        }
    }

    async refreshStatsAndLibrary() {
        this.stats = await Api.api_stats({});
        this.renderLibrary();
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
        this.photos = [];
        this.isLoadingChunk.clear();
        const params: Req.PagedPhotosRequest = { 
            limit: 100, offset: 0, 
            rootId: this.selectedRootId || undefined, 
            pickedOnly: this.filterType === 'picked',
            rating: this.filterRating, 
            specificIds: (this.filterType === 'collection' ? this.collectionFiles : (this.filterType === 'search' ? this.searchResultIds : undefined)) 
        };
        const [data, stats] = await Promise.all([ Api.api_photos(params), Api.api_stats({}) ]);
        this.totalPhotos = data.total;
        this.stats = stats;
        this.photos = new Array(this.totalPhotos).fill(null);
        data.photos.forEach((p: Photo, i: number) => { this.photos[i] = p; this.photoMap.set(p.id, p); });
        this.renderLibrary();
        this.renderGrid();
        if (this.isLoupeMode) this.renderFilmstrip();
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
            self.workspaceEl.innerHTML = `
                <div id="grid-header" class="grid-header">
                    <span id="header-text">All Photos</span>
                    <span id="header-count">0 items</span>
                </div>
                <div id="grid-container" style="flex:1; overflow-y:auto; position:relative;">
                    <div id="scroll-sentinel" style="position:absolute; top:0; left:0; right:0; height:0; pointer-events:none;"></div>
                    <div id="grid-view" class="grid-view" style="position:absolute; top:0; left:0; right:0;"></div>
                </div>
                <div id="loupe-view" class="loupe-view" style="display:none; height:100%;">
                    <div class="preview-area">
                        <div class="spinner center-spinner" id="preview-spinner"></div>
                        <img id="main-preview" src="" alt="">
                    </div>
                    <div id="filmstrip" class="filmstrip"></div>
                </div>
            `;
            container.getElement().append(self.workspaceEl);
            self.gridHeader = self.workspaceEl.querySelector('#grid-header');
            self.gridView = self.workspaceEl.querySelector('#grid-view');
            self.scrollSentinel = self.workspaceEl.querySelector('#scroll-sentinel');
            self.loupeView = self.workspaceEl.querySelector('#loupe-view');
            self.filmstrip = self.workspaceEl.querySelector('#filmstrip');
            self.mainPreview = self.workspaceEl.querySelector('#main-preview') as HTMLImageElement;
            self.previewSpinner = self.workspaceEl.querySelector('#preview-spinner');
            const gridScroll = self.workspaceEl.querySelector('#grid-container') as HTMLElement;
            gridScroll.onscroll = () => self.updateVirtualGrid();
            container.getElement().get(0).addEventListener('keydown', (e: KeyboardEvent) => self.handleKey(e));
            self.workspaceEl.tabIndex = 0;
            if (self.photos.length > 0) self.renderGrid();
        });
        this.layout.registerComponent('metadata', function(container: any) {
            self.metadataEl = document.createElement('div');
            self.metadataEl.className = 'metadata-panel gl-component';
            container.getElement().append(self.metadataEl);
        });
        this.layout.init();
        window.addEventListener('resize', () => { this.layout.updateSize(); hub.pub('ui.layout.changed', {}); });
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

    private updateViewModeUI() {
        const gridCont = (this.workspaceEl?.querySelector('#grid-container') as HTMLElement);
        if (this.isLoupeMode) {
            if (gridCont) gridCont.style.display = 'none';
            if (this.gridHeader) this.gridHeader.style.display = 'none';
            if (this.loupeView) this.loupeView.style.display = 'flex';
            document.getElementById('nav-grid')?.classList.remove('active');
            document.getElementById('nav-loupe')?.classList.add('active');
            this.renderFilmstrip();
        } else {
            if (this.loupeView) this.loupeView.style.display = 'none';
            if (gridCont) gridCont.style.display = 'flex';
            if (this.gridHeader) this.gridHeader.style.display = 'flex';
            document.getElementById('nav-loupe')?.classList.remove('active');
            document.getElementById('nav-grid')?.classList.add('active');
            this.updateVirtualGrid();
        }
    }

    private updatePhotoCardUI(photo: Photo) {
        const cards = this.workspaceEl?.querySelectorAll(`.card[data-id="${photo.id}"]`);
        cards?.forEach(card => {
            const pBtn = card.querySelector('.pick-btn');
            if (pBtn) { if (photo.isPicked) pBtn.classList.add('picked'); else pBtn.classList.remove('picked'); }
            const stars = card.querySelector('.stars');
            if (stars) {
                const el = stars as HTMLElement;
                el.innerText = '\u2605'.repeat(photo.rating) || '\u2606\u2606\u2606\u2606\u2606';
                if (photo.rating > 0) el.classList.add('has-rating'); else el.classList.remove('has-rating');
            }
        });
    }

    updateVirtualGrid() {
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
        if (startIndex !== this.visibleRange.start || endIndex !== this.visibleRange.end) {
            this.visibleRange = { start: startIndex, end: endIndex };
            this.renderVisiblePhotos();
        }
        this.checkMissingChunks(startIndex, endIndex);
    }

    renderVisiblePhotos() {
        if (!this.gridView) return;
        this.gridView.innerHTML = '';
        const startRow = Math.floor(this.visibleRange.start / this.cols);
        this.gridView.style.transform = `translateY(${startRow * this.rowHeight}px)`;
        for (let i = this.visibleRange.start; i < this.visibleRange.end; i++) {
            const photo = this.photos[i];
            if (photo) this.gridView.appendChild(this.createCard(photo, 'grid'));
            else {
                const placeholder = document.createElement('div');
                placeholder.className = 'card placeholder';
                placeholder.style.height = (this.rowHeight - 10) + 'px';
                placeholder.innerHTML = '<div class="img-container"><div class="spinner"></div></div>';
                this.gridView.appendChild(placeholder);
            }
        }
    }

    async checkMissingChunks(start: number, end: number) {
        const chunkSize = 100;
        const startChunk = Math.floor(start / chunkSize);
        const endChunk = Math.floor(end / chunkSize);
        for (let c = startChunk; c <= endChunk; c++) {
            const offset = c * chunkSize;
            if (!this.isLoadingChunk.has(offset) && !this.photos[offset]) this.loadChunk(offset, chunkSize);
        }
    }

    async loadChunk(offset: number, limit: number) {
        this.isLoadingChunk.add(offset);
        try {
            const params: Req.PagedPhotosRequest = { 
                limit, offset, 
                rootId: this.selectedRootId || undefined, 
                pickedOnly: this.filterType === 'picked', 
                rating: this.filterRating, 
                specificIds: (this.filterType === 'collection' ? this.collectionFiles : (this.filterType === 'search' ? this.searchResultIds : undefined)) 
            };
            const data = await Api.api_photos(params);
            data.photos.forEach((p: Photo, i: number) => { this.photos[offset + i] = p; this.photoMap.set(p.id, p); });
            this.renderVisiblePhotos();
        } finally { this.isLoadingChunk.delete(offset); }
    }

    renderLibrary() {
        if (!this.libraryEl) return;
        this.libraryEl.innerHTML = '';
        const searchHeader = document.createElement('div');
        searchHeader.className = 'tree-section-header';
        searchHeader.innerText = 'Search';
        this.libraryEl.appendChild(searchHeader);
        const searchBox = document.createElement('div');
        searchBox.className = 'search-box';
        const searchInput = document.createElement('input');
        searchInput.className = 'search-input';
        searchInput.placeholder = 'Tag search...';
        searchInput.onkeydown = (e) => { if (e.key === 'Enter') hub.pub('search.triggered', { tag: 'FileName', value: searchInput.value }); };
        searchBox.appendChild(searchInput);
        this.libraryEl.appendChild(searchBox);
        if (this.filterType === 'search') this.addTreeItem(this.libraryEl, '\uD83D\uDD0D ' + this.searchTitle, this.searchResultIds.length, () => this.setFilter('search'), true);
        const collHeader = document.createElement('div');
        collHeader.className = 'tree-section-header';
        collHeader.innerText = 'Collections';
        this.libraryEl.appendChild(collHeader);
        this.addTreeItem(this.libraryEl, 'All Photos', this.totalPhotos, () => this.setFilter('all'), this.filterType === 'all' && !this.selectedRootId);
        const pEl = this.addTreeItem(this.libraryEl, '\u2691 Picked', this.stats.pickedCount, () => this.setFilter('picked'), this.filterType === 'picked');
        pEl.oncontextmenu = (e) => { e.preventDefault(); this.showPickedContextMenu(e); };
        this.userCollections.forEach(c => {
            const el = this.addTreeItem(this.libraryEl!, '\uD83D\uDCC1 ' + c.name, c.count, () => this.setCollectionFilter(c), this.selectedCollectionId === c.id);
            el.oncontextmenu = (e) => { e.preventDefault(); this.showCollectionContextMenu(e, c); };
        });
        for (let i = 5; i >= 1; i--) {
            const count = this.stats.ratingCounts[i-1];
            this.addTreeItem(this.libraryEl, '\u2605'.repeat(i), count, () => this.setFilter('rating', i), this.filterType === 'rating' && this.filterRating === i);
        }
        const folderHeader = document.createElement('div');
        folderHeader.className = 'tree-section-header';
        folderHeader.innerText = 'Folders';
        this.libraryEl.appendChild(folderHeader);
        const treeContainer = document.createElement('div');
        this.libraryEl.appendChild(treeContainer);
        const map = new Map<string, { node: RootPath, children: any[] }>();
        this.roots.forEach(r => map.set(r.id, { node: r, children: [] }));
        const tree: any[] = [];
        this.roots.forEach(r => { if (r.parentId && map.has(r.parentId)) map.get(r.parentId)!.children.push(map.get(r.id)); else tree.push(map.get(r.id)); });
        const renderNode = (item: any, container: HTMLElement) => {
            this.addTreeItem(container, item.node.name!, 0, () => this.setFilter('all', 0, item.node.id), this.selectedRootId === item.node.id);
            if (item.children.length > 0) {
                const childContainer = document.createElement('div');
                childContainer.className = 'tree-children';
                item.children.forEach((c: any) => renderNode(c, childContainer));
                container.appendChild(childContainer);
            }
        };
        tree.forEach(t => renderNode(t, treeContainer));
    }

    addTreeItem(container: HTMLElement, text: string, count: number, onClick: () => void, isSelected: boolean) {
        const el = document.createElement('div');
        el.className = 'tree-item' + (isSelected ? ' selected' : '');
        el.innerHTML = `<span>${text}</span><span class="count">${count > 0 ? count : ''}</span>`;
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

    showPickedContextMenu(e: MouseEvent) {
        const menu = document.getElementById('context-menu')!;
        menu.innerHTML = '';
        const clear = document.createElement('div'); clear.className = 'context-menu-item'; clear.innerText = 'Clear All Picked'; clear.onclick = () => this.clearAllPicked(); menu.appendChild(clear);
        const divider = document.createElement('div'); divider.className = 'context-menu-divider'; menu.appendChild(divider);
        const storeNew = document.createElement('div'); storeNew.className = 'context-menu-item'; storeNew.innerText = 'Store to new collection...'; storeNew.onclick = () => this.storePickedToCollection(null); menu.appendChild(storeNew);
        this.userCollections.forEach(c => { const item = document.createElement('div'); item.className = 'context-menu-item'; item.innerText = `Store to '${c.name}'`; item.onclick = () => this.storePickedToCollection(c.id); menu.appendChild(item); });
        menu.style.display = 'block'; menu.style.left = e.pageX + 'px'; menu.style.top = e.pageY + 'px';
    }

    showCollectionContextMenu(e: MouseEvent, c: Collection) {
        const menu = document.getElementById('context-menu')!;
        menu.innerHTML = '';
        const del = document.createElement('div'); del.className = 'context-menu-item'; del.innerText = 'Remove Collection'; del.onclick = () => this.deleteCollection(c.id); menu.appendChild(del);
        menu.style.display = 'block'; menu.style.left = e.pageX + 'px'; menu.style.top = e.pageY + 'px';
    }

    async clearAllPicked() { await Api.api_picked_clear({}); this.refreshPhotos(); hub.pub('ui.notification', { message: 'Picked photos cleared', type: 'info' }); }

    async storePickedToCollection(id: string | null) {
        const pickedIds = await Api.api_picked_ids({});
        if (pickedIds.length === 0) return;
        if (id === null) {
            const name = prompt('New Collection Name:');
            if (!name) return;
            const res = await Api.api_collections_create({ name });
            id = res.id;
        }
        await Api.api_collections_add_files({ collectionId: id!, fileIds: pickedIds });
        hub.pub('ui.notification', { message: 'Photos added to collection', type: 'success' });
        await this.refreshCollections();
    }

    async deleteCollection(id: string) {
        if (!confirm('Are you sure you want to remove this collection?')) return;
        await Api.api_collections_delete({ id });
        hub.pub('ui.notification', { message: 'Collection deleted', type: 'info' });
        if (this.selectedCollectionId === id) this.setFilter('all');
        else await this.refreshCollections();
    }

    async refreshCollections() { this.userCollections = await Api.api_collections_list({}); this.renderLibrary(); }

    async searchPhotos(tag: string, value: string) {
        this.searchResultIds = await Api.api_search({ tag, value });
        this.searchTitle = `${tag}: ${value}`;
        this.setFilter('search');
    }

    public getFilteredPhotos(): Photo[] { return this.photos.filter(p => p !== null) as Photo[]; }

    renderGrid() {
        this.updateVirtualGrid();
        let headerText = "All Photos";
        if (this.filterType === 'picked') headerText = "Collection: Picked";
        else if (this.filterType === 'rating') headerText = "Collection: Starred";
        else if (this.filterType === 'search') headerText = "Search: " + this.searchTitle;
        else if (this.filterType === 'collection') { const c = this.userCollections.find(x => x.id === this.selectedCollectionId); headerText = "Collection: " + (c?.name || ""); }
        else if (this.selectedRootId) { const root = this.roots.find(r => r.id === this.selectedRootId); headerText = root ? `Folder: ${root.name}` : "Folder"; }
        if (this.gridHeader) {
            (this.gridHeader.querySelector('#header-text') as HTMLElement).innerHTML = `Showing <b>${headerText}</b>`;
            (this.gridHeader.querySelector('#header-count') as HTMLElement).innerText = `${this.totalPhotos} items`;
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
        if (type === 'grid') {
            const info = document.createElement('div');
            info.className = 'info';
            const starText = '\u2605'.repeat(p.rating) || '\u2606\u2606\u2606\u2606\u2606';
            const pickClass = p.isPicked ? 'picked' : '';
            info.innerHTML = `
                <div class="info-top"><span>${p.fileName}</span><span class="pick-btn ${pickClass}" onclick="event.stopPropagation(); app.togglePick('${p.id}')">⚑</span></div>
                <div class="info-bottom"><span class="stars ${p.rating>0?'has-rating':''}">` + starText + `</span></div>
            `;
            card.appendChild(info);
            card.addEventListener('dblclick', () => hub.pub('view.mode.changed', { mode: 'loupe', id: p.id }));
        }
        card.addEventListener('click', () => hub.pub('photo.selected', { id: p.id, photo: p }));
        return card;
    }

    lazyLoadImage(id: string, img: HTMLImageElement, size: number) {
        const target = img.parentElement || img;
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    this.requestImage(id, size).then(blob => {
                        img.onload = () => img.parentElement?.classList.add('loaded');
                        img.src = URL.createObjectURL(blob);
                    });
                    observer.disconnect();
                }
            });
        });
        observer.observe(target);
    }

    selectPhoto(id: string) {
        if (this.selectedId === id) return;
        const oldSel = this.workspaceEl?.querySelectorAll('.card.selected');
        oldSel?.forEach(e => e.classList.remove('selected'));
        this.selectedId = id;
        const newSel = this.workspaceEl?.querySelectorAll(`.card[data-id="${id}"]`);
        newSel?.forEach(e => e.classList.add('selected'));
        this.loadMetadata(id);
        if (this.isLoupeMode) this.loadMainPreview(id);
    }

    enterLoupeMode(id: string) {
        this.isLoupeMode = true;
        if (this.workspaceEl) {
            const cont = this.workspaceEl.querySelector('#grid-container') as HTMLElement;
            if (cont) cont.style.display = 'none';
        }
        if (this.gridHeader) this.gridHeader.style.display = 'none';
        if (this.loupeView) this.loupeView.style.display = 'flex';
        document.getElementById('nav-grid')?.classList.remove('active');
        document.getElementById('nav-loupe')?.classList.add('active');
        this.renderFilmstrip();
        this.selectPhoto(id);
        this.loadMainPreview(id);
    }

    enterGridMode() {
        this.isLoupeMode = false;
        if (this.loupeView) this.loupeView.style.display = 'none';
        if (this.workspaceEl) {
            const cont = this.workspaceEl.querySelector('#grid-container') as HTMLElement;
            if (cont) cont.style.display = 'flex';
        }
        if (this.gridHeader) this.gridHeader.style.display = 'flex';
        document.getElementById('nav-loupe')?.classList.remove('active');
        document.getElementById('nav-grid')?.classList.add('active');
        if (this.selectedId) {
            const index = this.photos.findIndex(p => p?.id === this.selectedId);
            if (index !== -1) {
                const row = Math.floor(index / this.cols);
                const cont = this.gridView!.parentElement as HTMLElement;
                if (cont) cont.scrollTop = row * this.rowHeight - (cont.clientHeight / 2) + (this.rowHeight / 2);
            }
        }
        this.updateVirtualGrid();
    }

    loadMainPreview(id: string) {
        if (!this.mainPreview) return;
        this.mainPreview.style.display = 'none';
        this.previewSpinner!.style.display = 'block';
        this.requestImage(id, 1024).then(blob => {
            if (this.selectedId === id) {
                this.mainPreview!.src = URL.createObjectURL(blob);
                this.mainPreview!.style.display = 'block';
                this.previewSpinner!.style.display = 'none';
            }
        });
    }

    async loadMetadata(id: string) {
        if (!this.metadataEl) return;
        const photo = this.photoMap.get(id);
        if (!photo) return;
        const priorityTags = ['Exposure Time', 'Shutter Speed Value', 'F-Number', 'Aperture Value', 'Max Aperture Value', 'ISO Speed Rating', 'ISO', 'Focal Length', 'Focal Length 35', 'Lens Model', 'Lens', 'Model', 'Make', 'Exposure Bias Value', 'Exposure Mode', 'Exposure Program', 'Focus Mode', 'Image Stabilisation', 'Metering Mode', 'White Balance', 'Flash', 'Color Temperature', 'Quality', 'Created', 'Size', 'Image Width', 'Image Height', 'Exif Image Width', 'Exif Image Height', 'Software', 'Orientation', 'ID'];
        const groupOrder = ['File Info', 'Exif SubIF', 'Exif IFD0', 'Sony Maker', 'GPS', 'XMP'];
        this.metadataEl.innerHTML = 'Loading...';
        try {
            const meta = await Api.api_metadata({ id });
            const groups: {[k:string]: MetadataItem[]} = {};
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
            const pickText = photo.isPicked ? '\u2691' : '';
            const starsText = photo.rating > 0 ? '\u2605'.repeat(photo.rating) : '';
            let html = `<h2>${photo.fileName} ${pickText} ${starsText}</h2>`;
            for (const k of sortedGroupKeys) {
                const items = groups[k];
                items.sort((a, b) => { let ia = priorityTags.indexOf(a.tag!); let ib = priorityTags.indexOf(b.tag!); if (ia === -1) ia = 999; if (ib === -1) ib = 999; if (ia !== ib) return ia - ib; return a.tag!.localeCompare(b.tag!); });
                html += `<div class="meta-group"><h3>${k}</h3>`;
                items.forEach(m => {
                    const tagEsc = m.tag!.replace(/'/g, "\'"); const valEsc = m.value!.replace(/'/g, "\'");
                    html += `<div class="meta-row"><span class="meta-key">${m.tag}</span><span class="meta-val">${m.value}</span><span class="meta-search-btn" title="Search" onclick="hub.pub('search.triggered', { tag: '${tagEsc}', value: '${valEsc}' })">�\uDD0D</span></div>`;
                });
                html += `</div>`;
            }
            this.metadataEl.innerHTML = html;
        } catch { this.metadataEl.innerHTML = 'Error'; }
    }

    async togglePick(id: string | null) {
        if (!id) return;
        const photo = this.photoMap.get(id);
        if (!photo) return;
        photo.isPicked = !photo.isPicked;
        if (photo.isPicked) hub.pub('photo.picked.added', { id }); else hub.pub('photo.picked.removed', { id });
        hub.pub('photo.updated', { id, photo });
        try { await Api.api_pick({ id, isPicked: photo.isPicked }); } catch { photo.isPicked = !photo.isPicked; hub.pub('photo.updated', { id, photo }); }
    }

    async setRating(id: string | null, rating: number) {
        if (!id) return;
        const photo = this.photoMap.get(id);
        if (!photo) return;
        const prev = photo.rating; photo.rating = rating;
        if (prev === 0 && rating > 0) hub.pub('photo.starred.added', { id, rating });
        else if (prev > 0 && rating === 0) hub.pub('photo.starred.removed', { id, previousRating: prev });
        else hub.pub('photo.starred.changed', { id, rating, previousRating: prev });
        hub.pub('photo.updated', { id, photo });
        try { await Api.api_rate({ id, rating }); } catch { photo.rating = prev; hub.pub('photo.updated', { id, photo }); }
    }

    private handleKey(e: KeyboardEvent) {
        const key = e.key.toLowerCase();
        if (key === 'g') hub.pub('view.mode.changed', { mode: 'grid' });
        if (key === 'l') { if (this.selectedId) hub.pub('view.mode.changed', { mode: 'loupe', id: this.selectedId }); }
        if (key === 'p') this.togglePick(this.selectedId);
        if (key >= '0' && key <= '5') this.setRating(this.selectedId, parseInt(key));
        if (key === '?' || key === '/') { if (key === '?' || (key === '/' && e.shiftKey)) { e.preventDefault(); hub.pub('shortcuts.show', {}); } }
        if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(e.key.toLowerCase())) { e.preventDefault(); this.navigate(e.key); }
    }

    private navigate(key: string) {
        const photos = this.photos.filter(p => p !== null) as Photo[];
        if (photos.length === 0) return;
        let index = this.selectedId ? photos.findIndex(p => p?.id === this.selectedId) : -1;
        if (key === 'ArrowRight') index++; else if (key === 'ArrowLeft') index--;
        else if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (this.isLoupeMode) { if (key === 'ArrowDown') index++; else index--; } 
            else { if (key === 'ArrowDown') index += this.cols; else index -= this.cols; }
        }
        if (index >= 0 && index < photos.length) { const target = photos[index]; if (target) hub.pub('photo.selected', { id: target.id, photo: target }); }
    }

    private setupGlobalKeyboard() {
        document.addEventListener('keydown', (e) => { if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return; if (e.key === '?' || (e.key === '/' && e.shiftKey)) hub.pub('shortcuts.show', {}); });
    }

    connectWs() {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${window.location.host}/ws`);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onopen = () => { this.isConnected = true; hub.pub('connection.changed', { connected: true, connecting: false }); this.processPending(); };
        this.ws.onclose = () => { this.isConnected = false; hub.pub('connection.changed', { connected: false, connecting: false });
            const delay = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, this.maxReconnectDelay);
            this.reconnectAttempts++; setTimeout(() => { hub.pub('connection.changed', { connected: false, connecting: true }); this.connectWs(); }, delay); 
        };
        this.ws.onmessage = (e) => this.handleBinaryMessage(e.data);
    }

    handleBinaryMessage(buffer: ArrayBuffer) {
        const view = new DataView(buffer);
        const reqId = view.getInt32(0, true);
        const data = buffer.slice(4);
        if (this.requestMap.has(reqId)) { this.requestMap.get(reqId)!(new Blob([data], {type:'image/jpeg'})); this.requestMap.delete(reqId); }
    }

    requestImage(fileId: string, size: number): Promise<Blob> {
        return new Promise(resolve => {
            const requestId = this.nextRequestId++;
            this.requestMap.set(requestId, resolve);
            const payload = { requestId, fileId, size };
            if (this.isConnected && this.ws) this.ws.send(JSON.stringify(payload));
            else this.pendingRequests.push(payload);
        });
    }

    processPending() { while(this.pendingRequests.length && this.isConnected) { this.ws?.send(JSON.stringify(this.pendingRequests.shift())); } }
}

const app = new App();
(window as any).app = app;