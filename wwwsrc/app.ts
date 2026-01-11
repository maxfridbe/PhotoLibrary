// Types
declare var GoldenLayout: any;
declare var $: any;

interface Photo { id: string; fileName: string; createdAt: string; rootPathId: string; isPicked: boolean; rating: number; }
interface MetadataItem { directory: string; tag: string; value: string; }
interface RootPath { id: string; parentId: string | null; name: string; }
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
    public selectedId: string | null = null;
    private selectedRootId: string | null = null;
    private filterType: 'all' | 'picked' | 'rating' = 'all';
    private filterRating: number = 0;
    private isLoupeMode = false;

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
            const [rootsRes, photosRes] = await Promise.all([
                fetch('/api/directories'),
                fetch('/api/photos')
            ]);
            this.roots = await rootsRes.json();
            this.photos = await photosRes.json();
            this.photoMap = new Map(this.photos.map(p => [p.id, p]));
            this.renderLibrary();
            this.renderGrid();
        } catch (e) { console.error("Load failed", e); }
    }

    // --- Library Tree ---
    renderLibrary() {
        if (!this.libraryEl) return;
        this.libraryEl.innerHTML = '';

        const collHeader = document.createElement('div');
        collHeader.className = 'tree-section-header';
        collHeader.innerText = 'Collections';
        this.libraryEl.appendChild(collHeader);

        this.addTreeItem(this.libraryEl, 'All Photos', this.photos.length, () => this.setFilter('all'), this.filterType === 'all' && !this.selectedRootId);
        const pickedCount = this.photos.filter(p => p.isPicked).length;
        this.addTreeItem(this.libraryEl, '⚑ Picked', pickedCount, () => this.setFilter('picked'), this.filterType === 'picked');
        const ratedCount = this.photos.filter(p => p.rating > 0).length;
        this.addTreeItem(this.libraryEl, '★ Starred (1+)', ratedCount, () => this.setFilter('rating', 1), this.filterType === 'rating');

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
            const el = this.addTreeItem(container, item.node.name, count, () => this.setFilter('all', 0, item.node.id), this.selectedRootId === item.node.id);
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
        el.innerHTML = `<span>${text}</span><span class="count">${count}</span>`;
        el.onclick = onClick;
        container.appendChild(el);
        return el;
    }

    setFilter(type: 'all' | 'picked' | 'rating', rating: number = 0, rootId: string | null = null) {
        this.filterType = type;
        this.filterRating = rating;
        this.selectedRootId = rootId;
        this.renderLibrary();
        this.renderGrid();
        if (this.isLoupeMode) this.renderFilmstrip();
    }

    getFilteredPhotos() {
        let list = this.photos;
        if (this.filterType === 'picked') list = list.filter(p => p.isPicked);
        else if (this.filterType === 'rating') list = list.filter(p => p.rating >= this.filterRating);
        if (this.selectedRootId) list = list.filter(p => p.rootPathId === this.selectedRootId);
        return list;
    }

    // --- Workspace ---
    renderGrid() {
        if (!this.gridView || !this.gridHeader) return;
        this.gridView.innerHTML = '';
        const photos = this.getFilteredPhotos();

        let headerText = "All Photos";
        if (this.filterType === 'picked') headerText = "Collection: Picked";
        else if (this.filterType === 'rating') headerText = "Collection: Starred";
        else if (this.selectedRootId) {
            const root = this.roots.find(r => r.id === this.selectedRootId);
            headerText = root ? `Folder: ${root.name}` : "Folder";
        }
        (this.gridHeader.querySelector('#header-text') as HTMLElement).innerHTML = `Showing <b>${headerText}</b>`;
        (this.gridHeader.querySelector('#header-count') as HTMLElement).innerText = `${photos.length} items`;

        photos.forEach(p => {
            const card = this.createCard(p, 'grid');
            this.gridView!.appendChild(card);
        });
    }

    renderFilmstrip() {
        if (!this.filmstrip) return;
        this.filmstrip.innerHTML = '';
        const photos = this.getFilteredPhotos();
        photos.forEach(p => {
            const card = this.createCard(p, 'filmstrip');
            this.filmstrip!.appendChild(card);
        });
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
        this.renderFilmstrip();
        this.selectPhoto(id);
        this.loadMainPreview(id);
    }

    enterGridMode() {
        this.isLoupeMode = false;
        this.loupeView!.style.display = 'none';
        this.gridView!.style.display = 'grid';
        this.gridHeader!.style.display = 'flex';
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
        this.metadataEl.innerHTML = 'Loading...';
        try {
            const res = await fetch(`/api/metadata/${id}`);
            const meta: MetadataItem[] = await res.json();
            let html = `<h2>${photo.fileName} ${photo.isPicked ? '⚑' : ''} ${photo.rating > 0 ? '★'.repeat(photo.rating) : ''}</h2>`;
            const groups: {[k:string]: MetadataItem[]} = {};
            meta.forEach(m => {
                const k = m.directory || 'Unknown';
                if (!groups[k]) groups[k] = [];
                groups[k].push(m);
            });
            for (const k in groups) {
                html += `<div class="meta-group"><h3>${k}</h3>`;
                groups[k].forEach(m => {
                    html += `<div class="meta-row"><span class="meta-key">${m.tag}</span><span class="meta-val">${m.value}</span></div>`;
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

    // --- Navigation ---
    private handleKey(e: KeyboardEvent) {
        const key = e.key.toLowerCase();
        if (key === 'g') this.enterGridMode();
        if (key === 'l') { if (this.selectedId) this.enterLoupeMode(this.selectedId); }
        if (key === 'p') this.togglePick(this.selectedId);
        if (key >= '0' && key <= '5') this.setRating(this.selectedId, parseInt(key));
        if (key === '?' || key === '/') {
            if (key === '?' || (key === '/' && e.shiftKey)) {
                e.preventDefault();
                this.showShortcuts();
            }
        }
        
        if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(e.key.toLowerCase())) {
            e.preventDefault();
            this.navigate(e.key);
        }
    }

    private navigate(key: string) {
        const photos = this.getFilteredPhotos();
        if (photos.length === 0) return;
        
        let index = this.selectedId ? photos.findIndex(p => p.id === this.selectedId) : -1;
        
        if (key === 'ArrowRight') index++;
        else if (key === 'ArrowLeft') index--;
        else if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (this.isLoupeMode) {
                if (key === 'ArrowDown') index++; else index--;
            } else {
                // Grid navigation (complex as columns change)
                const grid = this.gridView!;
                const cards = grid.children;
                if (cards.length === 0) return;
                
                // Estimate columns
                const containerWidth = grid.clientWidth;
                const cardWidth = (cards[0] as HTMLElement).offsetWidth + 10; // 10 is gap
                const cols = Math.max(1, Math.floor(containerWidth / cardWidth));
                
                if (key === 'ArrowDown') index += cols;
                else index -= cols;
            }
        }

        if (index >= 0 && index < photos.length) {
            this.selectPhoto(photos[index].id);
        }
    }

    private showShortcuts() {
        document.getElementById('shortcuts-modal')?.classList.add('active');
    }

    private setupGlobalKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            // Only handle if not already handled by a component or to trigger global ones
            if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
                this.showShortcuts();
            }
        });
    }

    // --- Networking ---
    connectWs() {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${window.location.host}/ws`);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onopen = () => { this.isConnected = true; this.processPending(); };
        this.ws.onclose = () => { this.isConnected = false; setTimeout(() => this.connectWs(), 2000); };
        this.ws.onmessage = (e) => this.handleBinaryMessage(e.data);
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