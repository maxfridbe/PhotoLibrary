// Types
declare var GoldenLayout: any;
declare var $: any;

interface Photo { id: string; fileName: string; createdAt: string; rootPathId: string; isPicked: boolean; rating: number; size: number; }
interface MetadataItem { directory: string; tag: string; value: string; }
interface RootPath { id: string; parentId: string | null; name: string; }
interface Collection { id: string; name: string; }
interface ImageRequest { requestId: number; fileId: string; size: number; }

class App {
    private layout: any;
    private ws: WebSocket | null = null;
    private requestMap: Map<number, (blob: Blob) => void> = new Map();
    private nextRequestId = 1;
    private isConnected = false;
    private pendingRequests: ImageRequest[] = [];

    // State
    private photos: Photo[] = [];
    private photoMap: Map<string, Photo> = new Map();
    private roots: RootPath[] = [];
    private userCollections: Collection[] = [];
    
    public selectedId: string | null = null;
    private selectedRootId: string | null = null;
    private selectedCollectionId: string | null = null;
    private filterType: 'all' | 'picked' | 'rating' | 'search' | 'collection' = 'all';
    private filterRating: number = 0;
    
    private searchResultIds: string[] = [];
    private searchTitle: string = '';
    private collectionFiles: string[] = []; // IDs for current selected collection

    private isLoupeMode = false;
    private reconnectAttempts = 0;
    private readonly maxReconnectDelay = 256000;

    // Components
    private libraryEl: HTMLElement | null = null;
    private workspaceEl: HTMLElement | null = null;
    private metadataEl: HTMLElement | null = null;

    // Workspace Elements
    private gridHeader: HTMLElement | null = null;
    private gridView: HTMLElement | null = null;
    private loupeView: HTMLElement | null = null;
    private filmstrip: HTMLElement | null = null;
    private mainPreview: HTMLImageElement | null = null;
    private previewSpinner: HTMLElement | null = null;

    constructor() {
        this.initLayout();
        this.connectWs();
        this.loadData();
        this.setupGlobalKeyboard();
        this.setupContextMenu();
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
            self.workspaceEl.innerHTML = `
                <div id="grid-header" class="grid-header">
                    <span id="header-text">All Photos</span>
                    <span id="header-count">0 items</span>
                </div>
                <div id="grid-view" class="grid-view">Loading...</div>
                <div id="loupe-view" class="loupe-view" style="display:none;">
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
            self.loupeView = self.workspaceEl.querySelector('#loupe-view');
            self.filmstrip = self.workspaceEl.querySelector('#filmstrip');
            self.mainPreview = self.workspaceEl.querySelector('#main-preview') as HTMLImageElement;
            self.previewSpinner = self.workspaceEl.querySelector('#preview-spinner');
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
        window.addEventListener('resize', () => this.layout.updateSize());
    }

    async loadData() {
        try {
            const [rootsRes, photosRes, collsRes] = await Promise.all([
                fetch('/api/directories'),
                fetch('/api/photos'),
                fetch('/api/collections')
            ]);
            this.roots = await rootsRes.json();
            this.photos = await photosRes.json();
            this.userCollections = await collsRes.json();
            this.photoMap = new Map(this.photos.map(p => [p.id, p]));
            this.renderLibrary();
            this.renderGrid();
        } catch (e) { console.error("Load failed", e); }
    }

    // --- Library Tree ---
    renderLibrary() {
        if (!this.libraryEl) return;
        this.libraryEl.innerHTML = '';

        // Search Section
        const searchHeader = document.createElement('div');
        searchHeader.className = 'tree-section-header';
        searchHeader.innerText = 'Search';
        this.libraryEl.appendChild(searchHeader);
        const searchBox = document.createElement('div');
        searchBox.className = 'search-box';
        const searchInput = document.createElement('input');
        searchInput.className = 'search-input';
        searchInput.placeholder = 'Tag search...';
        searchInput.onkeydown = (e) => { if (e.key === 'Enter') this.searchPhotos('FileName', searchInput.value); };
        searchBox.appendChild(searchInput);
        this.libraryEl.appendChild(searchBox);
        if (this.filterType === 'search') {
            this.addTreeItem(this.libraryEl, '🔍 ' + this.searchTitle, this.searchResultIds.length, () => this.setFilter('search'), true);
        }

        // Collections Section
        const collHeader = document.createElement('div');
        collHeader.className = 'tree-section-header';
        collHeader.innerText = 'Collections';
        this.libraryEl.appendChild(collHeader);

        this.addTreeItem(this.libraryEl, 'All Photos', this.photos.length, () => this.setFilter('all'), this.filterType === 'all' && !this.selectedRootId);
        
        // Picked item with context menu
        const pickedCount = this.photos.filter(p => p.isPicked).length;
        const pEl = this.addTreeItem(this.libraryEl, '⚑ Picked', pickedCount, () => this.setFilter('picked'), this.filterType === 'picked');
        pEl.oncontextmenu = (e) => { e.preventDefault(); this.showPickedContextMenu(e); };

        // User Collections
        this.userCollections.forEach(c => {
            const el = this.addTreeItem(this.libraryEl!, '📁 ' + c.name, 0, () => this.setCollectionFilter(c), this.selectedCollectionId === c.id);
            el.oncontextmenu = (e) => { e.preventDefault(); this.showCollectionContextMenu(e, c); };
            // Note: counts for collections could be loaded but keeping it simple for now
        });

        // Stars (1+)
        const ratedCount = this.photos.filter(p => p.rating > 0).length;
        this.addTreeItem(this.libraryEl, '★ Starred (1+)', ratedCount, () => this.setFilter('rating', 1), this.filterType === 'rating');

        // Folders Section
        const folderHeader = document.createElement('div');
        folderHeader.className = 'tree-section-header';
        folderHeader.innerText = 'Folders';
        this.libraryEl.appendChild(folderHeader);
        const treeContainer = document.createElement('div');
        this.libraryEl.appendChild(treeContainer);
        const map = new Map<string, { node: RootPath, children: any[] }>();
        this.roots.forEach(r => map.set(r.id, { node: r, children: [] }));
        const tree: any[] = [];
        this.roots.forEach(r => {
            if (r.parentId && map.has(r.parentId)) map.get(r.parentId)!.children.push(map.get(r.id));
            else tree.push(map.get(r.id));
        });
        const renderNode = (item: any, container: HTMLElement) => {
            const count = this.photos.filter(p => p.rootPathId === item.node.id).length;
            this.addTreeItem(container, item.node.name, count, () => this.setFilter('all', 0, item.node.id), this.selectedRootId === item.node.id);
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
        this.renderLibrary();
        this.renderGrid();
        if (this.isLoupeMode) this.renderFilmstrip();
    }

    async setCollectionFilter(c: Collection) {
        this.filterType = 'collection';
        this.selectedCollectionId = c.id;
        this.selectedRootId = null;
        const res = await fetch(`/api/collections/${c.id}/files`);
        this.collectionFiles = await res.json();
        this.renderLibrary();
        this.renderGrid();
        if (this.isLoupeMode) this.renderFilmstrip();
    }

    getFilteredPhotos() {
        let list = this.photos;
        if (this.filterType === 'picked') list = list.filter(p => p.isPicked);
        else if (this.filterType === 'rating') list = list.filter(p => p.rating >= this.filterRating);
        else if (this.filterType === 'search') list = list.filter(p => this.searchResultIds.includes(p.id));
        else if (this.filterType === 'collection') list = list.filter(p => this.collectionFiles.includes(p.id));
        if (this.selectedRootId) list = list.filter(p => p.rootPathId === this.selectedRootId);
        return list;
    }

    // --- Context Menus ---
    setupContextMenu() {
        document.addEventListener('click', () => {
            const menu = document.getElementById('context-menu');
            if (menu) menu.style.display = 'none';
        });
    }

    showPickedContextMenu(e: MouseEvent) {
        const menu = document.getElementById('context-menu')!;
        menu.innerHTML = '';
        
        const clear = document.createElement('div');
        clear.className = 'context-menu-item';
        clear.innerText = 'Clear All Picked';
        clear.onclick = () => this.clearAllPicked();
        menu.appendChild(clear);

        const divider = document.createElement('div');
        divider.className = 'context-menu-divider';
        menu.appendChild(divider);

        const storeNew = document.createElement('div');
        storeNew.className = 'context-menu-item';
        storeNew.innerText = 'Store to new collection...';
        storeNew.onclick = () => this.storePickedToCollection(null);
        menu.appendChild(storeNew);

        this.userCollections.forEach(c => {
            const item = document.createElement('div');
            item.className = 'context-menu-item';
            item.innerText = `Store to '${c.name}'`;
            item.onclick = () => this.storePickedToCollection(c.id);
            menu.appendChild(item);
        });

        menu.style.display = 'block';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
    }

    showCollectionContextMenu(e: MouseEvent, c: Collection) {
        const menu = document.getElementById('context-menu')!;
        menu.innerHTML = '';
        const del = document.createElement('div');
        del.className = 'context-menu-item';
        del.innerText = 'Remove Collection';
        del.onclick = () => this.deleteCollection(c.id);
        menu.appendChild(del);

        menu.style.display = 'block';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
    }

    async clearAllPicked() {
        await fetch('/api/picked/clear', { method: 'POST' });
        this.photos.forEach(p => p.isPicked = false);
        this.renderLibrary();
        this.renderGrid();
    }

    async storePickedToCollection(id: string | null) {
        const pickedIds = this.photos.filter(p => p.isPicked).map(p => p.id);
        if (pickedIds.length === 0) return;

        if (id === null) {
            const name = prompt('New Collection Name:');
            if (!name) return;
            const res = await fetch(`/api/collections?name=${encodeURIComponent(name)}`, { method: 'POST' });
            const coll = await res.json();
            this.userCollections.push(coll);
            id = coll.id;
        }

        await fetch(`/api/collections/${id}/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pickedIds)
        });
        this.renderLibrary();
    }

    async deleteCollection(id: string) {
        if (!confirm('Are you sure you want to remove this collection?')) return;
        await fetch(`/api/collections/${id}`, { method: 'DELETE' });
        this.userCollections = this.userCollections.filter(c => c.id !== id);
        if (this.selectedCollectionId === id) this.setFilter('all');
        else this.renderLibrary();
    }

    // --- Core Logic ---
    async searchPhotos(tag: string, value: string) {
        const res = await fetch(`/api/search?tag=${encodeURIComponent(tag)}&value=${encodeURIComponent(value)}`);
        this.searchResultIds = await res.json();
        this.searchTitle = `${tag}: ${value}`;
        this.setFilter('search');
    }

    renderGrid() {
        if (!this.gridView || !this.gridHeader) return;
        this.gridView.innerHTML = '';
        const photos = this.getFilteredPhotos();
        let headerText = "All Photos";
        if (this.filterType === 'picked') headerText = "Collection: Picked";
        else if (this.filterType === 'rating') headerText = "Collection: Starred";
        else if (this.filterType === 'search') headerText = "Search: " + this.searchTitle;
        else if (this.filterType === 'collection') {
            const c = this.userCollections.find(x => x.id === this.selectedCollectionId);
            headerText = "Collection: " + (c?.name || "");
        }
        else if (this.selectedRootId) {
            const root = this.roots.find(r => r.id === this.selectedRootId);
            headerText = root ? `Folder: ${root.name}` : "Folder";
        }
        (this.gridHeader.querySelector('#header-text') as HTMLElement).innerHTML = `Showing <b>${headerText}</b>`;
        (this.gridHeader.querySelector('#header-count') as HTMLElement).innerText = `${photos.length} items`;
        photos.forEach(p => this.gridView!.appendChild(this.createCard(p, 'grid')));
    }

    renderFilmstrip() {
        if (!this.filmstrip) return;
        this.filmstrip.innerHTML = '';
        const photos = this.getFilteredPhotos();
        photos.forEach(p => this.filmstrip!.appendChild(this.createCard(p, 'filmstrip')));
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
            info.innerHTML = `
                <div class="info-top"><span>${p.fileName}</span><span class="pick-btn ${p.isPicked?'picked':''}" onclick="event.stopPropagation(); app.togglePick('${p.id}')">⚑</span></div>
                <div class="info-bottom"><span class="stars ${p.rating>0?'has-rating':''}">` + ('★'.repeat(p.rating) || '☆☆☆☆☆') + `</span></div>
            `;
            card.appendChild(info);
            card.addEventListener('dblclick', () => this.enterLoupeMode(p.id));
        }
        card.addEventListener('click', () => this.selectPhoto(p.id));
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
        this.gridView!.style.display = 'none';
        this.gridHeader!.style.display = 'none';
        this.loupeView!.style.display = 'flex';
        document.getElementById('nav-grid')?.classList.remove('active');
        document.getElementById('nav-loupe')?.classList.add('active');
        this.renderFilmstrip();
        this.selectPhoto(id);
        this.loadMainPreview(id);
    }

    enterGridMode() {
        this.isLoupeMode = false;
        this.loupeView!.style.display = 'none';
        this.gridView!.style.display = 'grid';
        this.gridHeader!.style.display = 'flex';
        document.getElementById('nav-loupe')?.classList.remove('active');
        document.getElementById('nav-grid')?.classList.add('active');
        if (this.selectedId) {
            const el = this.gridView?.querySelector(`.card[data-id="${this.selectedId}"]`);
            el?.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
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
            const res = await fetch(`/api/metadata/${id}`);
            const meta: MetadataItem[] = await res.json();
            const groups: {[k:string]: MetadataItem[]} = {};
            meta.forEach(m => {
                const k = m.directory || 'Unknown';
                if (!groups[k]) groups[k] = [];
                groups[k].push(m);
            });
            groups['File Info'] = [
                { directory: 'File Info', tag: 'Created', value: new Date(photo.createdAt).toLocaleString() },
                { directory: 'File Info', tag: 'Size', value: (photo.size / (1024 * 1024)).toFixed(2) + ' MB' },
                { directory: 'File Info', tag: 'ID', value: id }
            ];
            const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
                const getMinPriority = (g: string) => {
                    const priorities = groups[g].map(i => priorityTags.indexOf(i.tag)).filter(p => p !== -1);
                    return priorities.length > 0 ? Math.min(...priorities) : 999;
                };
                const pa = getMinPriority(a);
                const pb = getMinPriority(b);
                if (pa !== pb) return pa - pb;
                let ia = groupOrder.indexOf(a); let ib = groupOrder.indexOf(b);
                if (ia === -1) ia = 999; if (ib === -1) ib = 999;
                return ia - ib;
            });
            let html = `<h2>${photo.fileName} ${photo.isPicked ? '⚑' : ''} ${photo.rating > 0 ? '★'.repeat(photo.rating) : ''}</h2>`;
            for (const k of sortedGroupKeys) {
                const items = groups[k];
                items.sort((a, b) => {
                    let ia = priorityTags.indexOf(a.tag); let ib = priorityTags.indexOf(b.tag);
                    if (ia === -1) ia = 999; if (ib === -1) ib = 999;
                    if (ia !== ib) return ia - ib;
                    return a.tag.localeCompare(b.tag);
                });
                html += `<div class="meta-group"><h3>${k}</h3>`;
                items.forEach(m => {
                    const tagEscaped = m.tag.replace(/'/g, "\\'");
                    const valEscaped = m.value.replace(/'/g, "\\'");
                    html += `<div class="meta-row">
                        <span class="meta-key">${m.tag}</span>
                        <span class="meta-val">${m.value}</span>
                        <span class="meta-search-btn" title="Search for photos with this value" onclick="app.searchPhotos('${tagEscaped}', '${valEscaped}')">🔍</span>
                    </div>`;
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
        const picks = this.workspaceEl?.querySelectorAll(`.card[data-id="${id}"] .pick-btn`);
        picks?.forEach(p => { if (photo.isPicked) p.classList.add('picked'); else p.classList.remove('picked'); });
        if (this.selectedId === id) this.loadMetadata(id);
        this.renderLibrary();
        try { await fetch(`/api/pick/${id}?isPicked=${photo.isPicked}`, { method: 'POST' }); } catch { photo.isPicked = !photo.isPicked; }
    }

    async setRating(id: string | null, rating: number) {
        if (!id) return;
        const photo = this.photoMap.get(id);
        if (!photo) return;
        photo.rating = rating;
        const stars = this.workspaceEl?.querySelectorAll(`.card[data-id="${id}"] .stars`);
        stars?.forEach(s => {
            const el = s as HTMLElement;
            el.innerText = '★'.repeat(rating) || '☆☆☆☆☆';
            if (rating > 0) el.classList.add('has-rating'); else el.classList.remove('has-rating');
        });
        if (this.selectedId === id) this.loadMetadata(id);
        this.renderLibrary();
        try { await fetch(`/api/rate/${id}/${rating}`, { method: 'POST' }); } catch { console.error('Failed to set rating'); }
    }

    private handleKey(e: KeyboardEvent) {
        const key = e.key.toLowerCase();
        if (key === 'g') this.enterGridMode();
        if (key === 'l') { if (this.selectedId) this.enterLoupeMode(this.selectedId); }
        if (key === 'p') this.togglePick(this.selectedId);
        if (key >= '0' && key <= '5') this.setRating(this.selectedId, parseInt(key));
        if (key === '?' || key === '/') { if (key === '?' || (key === '/' && e.shiftKey)) { e.preventDefault(); this.showShortcuts(); } }
        if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(e.key.toLowerCase())) { e.preventDefault(); this.navigate(e.key); }
    }

    private navigate(key: string) {
        const photos = this.getFilteredPhotos();
        if (photos.length === 0) return;
        let index = this.selectedId ? photos.findIndex(p => p.id === this.selectedId) : -1;
        if (key === 'ArrowRight') index++;
        else if (key === 'ArrowLeft') index--;
        else if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (this.isLoupeMode) { if (key === 'ArrowDown') index++; else index--; }
            else {
                const grid = this.gridView!;
                const cards = grid.children;
                if (cards.length === 0) return;
                const containerWidth = grid.clientWidth;
                const cardWidth = (cards[0] as HTMLElement).offsetWidth + 10;
                const cols = Math.max(1, Math.floor(containerWidth / cardWidth));
                if (key === 'ArrowDown') index += cols; else index -= cols;
            }
        }
        if (index >= 0 && index < photos.length) this.selectPhoto(photos[index].id);
    }

    private showShortcuts() { document.getElementById('shortcuts-modal')?.classList.add('active'); }

    private setupGlobalKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (e.key === '?' || (e.key === '/' && e.shiftKey)) this.showShortcuts();
        });
    }

    // --- Networking ---
    connectWs() {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${window.location.host}/ws`);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onopen = () => { this.isConnected = true; this.updateStatus(true); this.processPending(); };
        this.ws.onclose = () => {
            this.isConnected = false;
            this.updateStatus(false);
            const delay = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, this.maxReconnectDelay);
            this.reconnectAttempts++;
            setTimeout(() => this.connectWs(), delay); 
        };
        this.ws.onmessage = (e) => this.handleBinaryMessage(e.data);
    }

    updateStatus(connected: boolean, connecting: boolean = false) {
        const el = document.getElementById('connection-status');
        if (el) {
            if (connecting) { el.innerHTML = '<span class="spinner" style="display:inline-block; width:10px; height:10px; vertical-align:middle; margin-right:5px;"></span> Connecting...'; el.style.color = '#aaa'; }
            else if (connected) { el.innerText = 'Connected'; el.style.color = '#0f0'; }
            else { el.innerText = 'Disconnected'; el.style.color = '#f00'; }
        }
    }

    handleBinaryMessage(buffer: ArrayBuffer) {
        const view = new DataView(buffer);
        const reqId = view.getInt32(0, true);
        const data = buffer.slice(4);
        if (this.requestMap.has(reqId)) {
            this.requestMap.get(reqId)!(new Blob([data], {type:'image/jpeg'}));
            this.requestMap.delete(reqId);
        }
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

    processPending() {
        while(this.pendingRequests.length && this.isConnected) {
            this.ws?.send(JSON.stringify(this.pendingRequests.shift()));
        }
    }
}

(window as any).app = new App();