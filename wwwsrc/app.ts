// Types
declare var GoldenLayout: any;
declare var $: any;

interface Photo { id: string; fileName: string; createdAt: string; rootPathId: string; }
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

        this.layout.registerComponent('library', (container: any) => {
            this.libraryEl = document.createElement('div');
            this.libraryEl.className = 'tree-view gl-component';
            container.getElement().append(this.libraryEl);
        });

        this.layout.registerComponent('workspace', (container: any) => {
            this.workspaceEl = document.createElement('div');
            this.workspaceEl.className = 'gl-component';
            this.workspaceEl.innerHTML = `
                <div id="grid-view" class="grid-view">Loading...</div>
                <div id="loupe-view" class="loupe-view" style="display:none;">
                    <div class="preview-area">
                        <div class="spinner center-spinner" id="preview-spinner"></div>
                        <img id="main-preview" src="" alt="">
                    </div>
                    <div id="filmstrip" class="filmstrip"></div>
                </div>
            `;
            container.getElement().append(this.workspaceEl);
            
            // Cache elements
            this.gridView = this.workspaceEl.querySelector('#grid-view');
            this.loupeView = this.workspaceEl.querySelector('#loupe-view');
            this.filmstrip = this.workspaceEl.querySelector('#filmstrip');
            this.mainPreview = this.workspaceEl.querySelector('#main-preview');
            this.previewSpinner = this.workspaceEl.querySelector('#preview-spinner');

            // Keyboard
            container.getElement().get(0).addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key.toLowerCase() === 'g') this.enterGridMode();
            });
            // Focus for keyboard events
            this.workspaceEl.tabIndex = 0;
        });

        this.layout.registerComponent('metadata', (container: any) => {
            this.metadataEl = document.createElement('div');
            this.metadataEl.className = 'metadata-panel gl-component';
            this.metadataEl.innerHTML = '<div style="color:#666;text-align:center;margin-top:20px;">Select a photo</div>';
            container.getElement().append(this.metadataEl);
        });

        this.layout.init();
        
        // Handle resize
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

        // Build Tree
        const map = new Map<string, { node: RootPath, children: any[] }>();
        roots.forEach(r => map.set(r.id, { node: r, children: [] }));
        
        const tree: any[] = [];
        roots.forEach(r => {
            if (r.parentId && map.has(r.parentId)) {
                map.get(r.parentId)!.children.push(map.get(r.id));
            } else {
                tree.push(map.get(r.id));
            }
        });

        const renderNode = (item: any, container: HTMLElement) => {
            const el = document.createElement('div');
            el.className = 'tree-item';
            el.innerText = item.node.name;
            el.onclick = () => this.filterByRoot(item.node.id, el);
            container.appendChild(el);

            if (item.children.length > 0) {
                const childContainer = document.createElement('div');
                childContainer.className = 'tree-children';
                item.children.forEach((c: any) => renderNode(c, childContainer));
                container.appendChild(childContainer);
            }
        };

        const allBtn = document.createElement('div');
        allBtn.className = 'tree-item selected';
        allBtn.innerText = 'All Photos';
        allBtn.onclick = () => this.filterByRoot(null, allBtn);
        this.libraryEl.appendChild(allBtn);

        tree.forEach(t => renderNode(t, this.libraryEl!));
    }

    filterByRoot(rootId: string | null, el: HTMLElement) {
        // UI
        const current = this.libraryEl?.querySelector('.selected');
        if (current) current.classList.remove('selected');
        el.classList.add('selected');

        this.selectedRootId = rootId;
        this.renderGrid();
        if (this.isLoupeMode) this.renderFilmstrip();
    }

    getFilteredPhotos() {
        if (!this.selectedRootId) return this.photos;
        return this.photos.filter(p => p.rootPathId === this.selectedRootId);
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
        
        // Scroll selection into view
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
            info.innerText = p.fileName;
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
        
        // Update UI selection classes
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
            
            let html = `<h2>${photo.fileName}</h2>`;
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