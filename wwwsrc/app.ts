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
    private selectedId: string | null = null;
    private selectedRootId: string | null = null;
    private filterPicked: boolean = false;
    private isLoupeMode = false;

    // Components
    private libraryEl: HTMLElement | null = null;
    private workspaceEl: HTMLElement | null = null;
    private metadataEl: HTMLElement | null = null;

    // Workspace Elements
    private gridView: HTMLElement | null = null;
    private loupeView: HTMLElement | null = null;
    private filmstrip: HTMLElement | null = null;
    private mainPreview: HTMLImageElement | null = null;
    private previewSpinner: HTMLElement | null = null;

    constructor() {
        this.initLayout();
        this.connectWs();
        this.loadData();
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

        this.layout.registerComponent('library', function(container: any, state: any) {
            self.libraryEl = document.createElement('div');
            self.libraryEl.className = 'tree-view gl-component';
            container.getElement().append(self.libraryEl);
            if (self.photos.length > 0) self.renderLibrary([]); // Roots will be loaded by loadData
        });

        this.layout.registerComponent('workspace', function(container: any, state: any) {
            self.workspaceEl = document.createElement('div');
            self.workspaceEl.className = 'gl-component';
            self.workspaceEl.innerHTML = `
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
            
            self.gridView = self.workspaceEl.querySelector('#grid-view');
            self.loupeView = self.workspaceEl.querySelector('#loupe-view');
            self.filmstrip = self.workspaceEl.querySelector('#filmstrip');
            self.mainPreview = self.workspaceEl.querySelector('#main-preview') as HTMLImageElement;
            self.previewSpinner = self.workspaceEl.querySelector('#preview-spinner');

            container.getElement().get(0).addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key.toLowerCase() === 'g') self.enterGridMode();
                if (e.key.toLowerCase() === 'p') self.togglePick(self.selectedId);
                if (e.key >= '0' && e.key <= '5') self.setRating(self.selectedId, parseInt(e.key));
            });
            self.workspaceEl.tabIndex = 0;
            
            if (self.photos.length > 0) self.renderGrid();
        });

        this.layout.registerComponent('metadata', function(container: any, state: any) {
            self.metadataEl = document.createElement('div');
            self.metadataEl.className = 'metadata-panel gl-component';
            self.metadataEl.innerHTML = '<div style="color:#666;text-align:center;margin-top:20px;">Select a photo</div>';
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
            
            const roots: RootPath[] = await rootsRes.json();
            this.photos = await photosRes.json();
            this.photoMap = new Map(this.photos.map(p => [p.id, p]));

            this.renderLibrary(roots);
            this.renderGrid();
        } catch (e) {
            console.error("Load failed", e);
        }
    }

    // --- Library Tree ---
    renderLibrary(roots: RootPath[]) {
        if (!this.libraryEl) return;
        this.libraryEl.innerHTML = '';

        // Picked Node
        const pickedBtn = document.createElement('div');
        pickedBtn.className = 'tree-item';
        pickedBtn.innerText = '⚑ Picked';
        pickedBtn.onclick = () => this.filterByRoot(null, pickedBtn, true);
        this.libraryEl.appendChild(pickedBtn);

        // All Photos
        const allBtn = document.createElement('div');
        allBtn.className = 'tree-item selected';
        allBtn.innerText = 'All Photos';
        allBtn.onclick = () => this.filterByRoot(null, allBtn, false);
        this.libraryEl.appendChild(allBtn);

        // Directory Tree
        const map = new Map<string, { node: RootPath, children: any[] }>();
        roots.forEach(r => map.set(r.id, { node: r, children: [] }));
        const tree: any[] = [];
        roots.forEach(r => {
            if (r.parentId && map.has(r.parentId)) map.get(r.parentId)!.children.push(map.get(r.id));
            else tree.push(map.get(r.id));
        });

        const renderNode = (item: any, container: HTMLElement) => {
            const el = document.createElement('div');
            el.className = 'tree-item';
            el.innerText = item.node.name;
            el.onclick = () => this.filterByRoot(item.node.id, el, false);
            container.appendChild(el);

            if (item.children.length > 0) {
                const childContainer = document.createElement('div');
                childContainer.className = 'tree-children';
                item.children.forEach((c: any) => renderNode(c, childContainer));
                container.appendChild(childContainer);
            }
        };

        tree.forEach(t => renderNode(t, this.libraryEl!));
    }

    filterByRoot(rootId: string | null, el: HTMLElement, pickedOnly: boolean) {
        const current = this.libraryEl?.querySelector('.selected');
        if (current) current.classList.remove('selected');
        el.classList.add('selected');

        this.selectedRootId = rootId;
        this.filterPicked = pickedOnly;
        this.renderGrid();
        if (this.isLoupeMode) this.renderFilmstrip();
    }

    getFilteredPhotos() {
        let list = this.photos;
        if (this.filterPicked) {
            list = list.filter(p => p.isPicked);
        } else if (this.selectedRootId) {
            list = list.filter(p => p.rootPathId === this.selectedRootId);
        }
        return list;
    }

    // --- Workspace ---
    renderGrid() {
        if (!this.gridView) return;
        this.gridView.innerHTML = '';
        const photos = this.getFilteredPhotos();
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
            
            const top = document.createElement('div');
            top.className = 'info-top';
            const nameSpan = document.createElement('span');
            nameSpan.innerText = p.fileName;
            const pickBtn = document.createElement('span');
            pickBtn.className = `pick-btn ${p.isPicked ? 'picked' : ''}`;
            pickBtn.innerHTML = '⚑';
            pickBtn.onclick = (e) => { e.stopPropagation(); this.togglePick(p.id); };
            top.appendChild(nameSpan);
            top.appendChild(pickBtn);

            const bottom = document.createElement('div');
            bottom.className = 'info-bottom';
            const stars = document.createElement('span');
            stars.className = `stars ${p.rating > 0 ? 'has-rating' : ''}`;
            stars.innerText = '★'.repeat(p.rating) || '☆☆☆☆☆';
            bottom.appendChild(stars);

            info.appendChild(top);
            info.appendChild(bottom);
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
        this.loupeView!.style.display = 'flex';
        this.renderFilmstrip();
        this.selectPhoto(id);
        this.loadMainPreview(id);
    }

    enterGridMode() {
        this.isLoupeMode = false;
        this.loupeView!.style.display = 'none';
        this.gridView!.style.display = 'grid';
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
        } catch {
            this.metadataEl.innerHTML = 'Error';
        }
    }

    async togglePick(id: string | null) {
        if (!id) return;
        const photo = this.photoMap.get(id);
        if (!photo) return;

        photo.isPicked = !photo.isPicked;
        
        // Optimistic UI update
        const picks = this.workspaceEl?.querySelectorAll(`.card[data-id="${id}"] .pick-btn`);
        picks?.forEach(p => {
            if (photo.isPicked) p.classList.add('picked');
            else p.classList.remove('picked');
        });
        
        if (this.selectedId === id) this.loadMetadata(id);

        try {
            await fetch(`/api/pick/${id}?isPicked=${photo.isPicked}`, { method: 'POST' });
        } catch (e) {
            photo.isPicked = !photo.isPicked; // Revert
        }
    }

    async setRating(id: string | null, rating: number) {
        if (!id) return;
        const photo = this.photoMap.get(id);
        if (!photo) return;

        photo.rating = rating;
        
        // Optimistic UI update
        const stars = this.workspaceEl?.querySelectorAll(`.card[data-id="${id}"] .stars`);
        stars?.forEach(s => {
            const el = s as HTMLElement;
            el.innerText = '★'.repeat(rating) || '☆☆☆☆☆';
            if (rating > 0) el.classList.add('has-rating');
            else el.classList.remove('has-rating');
        });
        
        if (this.selectedId === id) this.loadMetadata(id);

        try {
            await fetch(`/api/rate/${id}/${rating}`, { method: 'POST' });
        } catch (e) {
            console.error('Failed to set rating');
        }
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

// Global shortcut support
document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'g') {
        (window as any).app.enterGridMode();
    }
});

(window as any).app = new App();