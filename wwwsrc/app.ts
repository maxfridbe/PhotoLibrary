interface Photo {
    id: string;
    fileName: string;
    createdAt: string;
}

interface MetadataItem {
    directory: string;
    tag: string;
    value: string;
}

interface ImageRequest {
    requestId: number;
    fileId: string;
    size: number;
}

class PhotoApp {
    private ws: WebSocket | null = null;
    private requestMap: Map<number, (blob: Blob) => void> = new Map();
    private nextRequestId = 1;
    private isConnected = false;
    private pendingRequests: ImageRequest[] = [];
    
    private photos: Photo[] = [];
    private photoMap: Map<string, Photo> = new Map();
    private selectedId: string | null = null;
    
    // UI State
    private isLoupeMode = false;
    
    // Elements
    private gridView: HTMLElement;
    private loupeView: HTMLElement;
    private filmstrip: HTMLElement;
    private mainPreview: HTMLImageElement;
    private previewSpinner: HTMLElement;
    private sidebar: HTMLElement;
    private viewModeLabel: HTMLElement;

    constructor() {
        this.gridView = document.getElementById('grid-view')!;
        this.loupeView = document.getElementById('loupe-view')!;
        this.filmstrip = document.getElementById('filmstrip')!;
        this.mainPreview = document.getElementById('main-preview') as HTMLImageElement;
        this.previewSpinner = document.getElementById('preview-spinner')!;
        this.sidebar = document.getElementById('sidebar')!;
        this.viewModeLabel = document.getElementById('view-mode')!;

        this.init();
        this.setupResizer();
        this.setupKeyboard();
    }

    async init() {
        this.connectWs();
        await this.loadPhotos();
    }

    connectWs() {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${window.location.host}/ws`);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.isConnected = true;
            this.updateStatus(true);
            this.processPending();
        };

        this.ws.onclose = () => {
            this.isConnected = false;
            this.updateStatus(false);
            setTimeout(() => this.connectWs(), 2000);
        };

        this.ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                this.handleBinaryMessage(event.data);
            }
        };
    }

    updateStatus(connected: boolean) {
        const el = document.getElementById('connection-status');
        if (el) {
            el.innerText = connected ? 'Connected' : 'Disconnected';
            el.className = connected ? 'connected' : '';
        }
    }

    handleBinaryMessage(buffer: ArrayBuffer) {
        const view = new DataView(buffer);
        const requestId = view.getInt32(0, true);
        const imageData = buffer.slice(4);

        if (this.requestMap.has(requestId)) {
            const blob = new Blob([imageData], { type: 'image/jpeg' });
            this.requestMap.get(requestId)!(blob);
            this.requestMap.delete(requestId);
        }
    }

    async loadPhotos() {
        try {
            const res = await fetch('/api/photos');
            this.photos = await res.json();
            this.photoMap = new Map(this.photos.map(p => [p.id, p]));
            
            this.renderGrid();
            this.renderFilmstrip();
        } catch (e) {
            console.error("Failed to load photos", e);
        }
    }

    // --- Rendering ---

    createCard(p: Photo, type: 'grid' | 'filmstrip'): HTMLElement {
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.id = p.id;
        
        const imgContainer = document.createElement('div');
        imgContainer.className = 'img-container';
        
        const img = document.createElement('img');
        img.loading = "lazy"; // Native lazy loading
        imgContainer.appendChild(img);

        // Fetch thumbnail
        // Use IntersectionObserver for true lazy loading of binary blobs if needed
        // For simplicity, trigger load when element created, but in real app use Observer
        this.lazyLoadImage(p.id, img, 300);

        card.appendChild(imgContainer);

        if (type === 'grid') {
            const info = document.createElement('div');
            info.className = 'info';
            info.innerText = p.fileName;
            card.appendChild(info);
        }

        // Events
        card.addEventListener('click', () => this.selectPhoto(p.id));
        if (type === 'grid') {
            card.addEventListener('dblclick', () => this.enterLoupeMode(p.id));
        }

        return card;
    }

    renderGrid() {
        this.gridView.innerHTML = '';
        this.photos.forEach(p => {
            const card = this.createCard(p, 'grid');
            this.gridView.appendChild(card);
        });
    }

    renderFilmstrip() {
        this.filmstrip.innerHTML = '';
        this.photos.forEach(p => {
            const card = this.createCard(p, 'filmstrip');
            this.filmstrip.appendChild(card);
        });
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

    // --- Interaction ---

    selectPhoto(id: string) {
        if (this.selectedId === id) return;

        // Deselect previous
        if (this.selectedId) {
            const prevGrid = this.gridView.querySelector(`.card[data-id="${this.selectedId}"]`);
            const prevStrip = this.filmstrip.querySelector(`.card[data-id="${this.selectedId}"]`);
            if (prevGrid) prevGrid.classList.remove('selected');
            if (prevStrip) prevStrip.classList.remove('selected');
        }

        this.selectedId = id;

        // Select new
        const newGrid = this.gridView.querySelector(`.card[data-id="${id}"]`);
        const newStrip = this.filmstrip.querySelector(`.card[data-id="${id}"]`);
        
        if (newGrid) {
            newGrid.classList.add('selected');
            if (!this.isLoupeMode) newGrid.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        if (newStrip) {
            newStrip.classList.add('selected');
            if (this.isLoupeMode) newStrip.scrollIntoView({ behavior: 'smooth', inline: 'center' });
        }

        this.loadMetadata(id);

        if (this.isLoupeMode) {
            this.loadMainPreview(id);
        }
    }

    enterLoupeMode(id: string) {
        this.isLoupeMode = true;
        this.gridView.classList.add('hidden');
        this.loupeView.classList.add('active');
        this.viewModeLabel.innerText = "Loupe View (Press 'G' for Grid)";
        
        this.selectPhoto(id);
        this.loadMainPreview(id); // Ensure main preview loads (selectPhoto calls it if mode is set, but might return early)
    }

    enterGridMode() {
        this.isLoupeMode = false;
        this.loupeView.classList.remove('active');
        this.gridView.classList.remove('hidden');
        this.viewModeLabel.innerText = "Grid View";
        
        // Scroll to selected
        if (this.selectedId) {
            const el = this.gridView.querySelector(`.card[data-id="${this.selectedId}"]`);
            if (el) el.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
    }

    loadMainPreview(id: string) {
        this.mainPreview.style.display = 'none';
        this.previewSpinner.style.display = 'block';
        
        // Request 1024px
        this.requestImage(id, 1024).then(blob => {
            // Only update if selection hasn't changed
            if (this.selectedId === id) {
                this.mainPreview.src = URL.createObjectURL(blob);
                this.mainPreview.style.display = 'block';
                this.previewSpinner.style.display = 'none';
            }
        });
    }

    async loadMetadata(id: string) {
        const photo = this.photoMap.get(id);
        if (!photo) return;

        this.sidebar.innerHTML = '<div style="color:#888; text-align:center; margin-top:20px;">Loading metadata...</div>';

        try {
            const res = await fetch(`/api/metadata/${id}`);
            const meta: MetadataItem[] = await res.json();
            
            const groups: { [key: string]: MetadataItem[] } = {};
            meta.forEach(m => {
                const dir = m.directory || 'Unknown';
                if (!groups[dir]) groups[dir] = [];
                groups[dir].push(m);
            });

            let html = `<h2>${photo.fileName}</h2>`;
            html += `
                <div class="meta-group">
                    <h3>File Info</h3>
                    <div class="meta-row"><span class="meta-key">Created</span><span class="meta-val">${new Date(photo.createdAt).toLocaleString()}</span></div>
                    <div class="meta-row"><span class="meta-key">ID</span><span class="meta-val" title="${id}">${id.substring(0,8)}...</span></div>
                </div>
            `;

            for (const dir of Object.keys(groups)) {
                html += `<div class="meta-group"><h3>${dir}</h3>`;
                groups[dir].forEach(m => {
                    html += `<div class="meta-row"><span class="meta-key">${m.tag}</span><span class="meta-val">${m.value}</span></div>`;
                });
                html += `</div>`;
            }

            this.sidebar.innerHTML = html;
        } catch (e) {
            this.sidebar.innerHTML = 'Error loading metadata';
        }
    }

    // --- Helpers ---

    setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 'g') {
                this.enterGridMode();
            }
            // Arrow key navigation could be added here
        });
    }

    setupResizer() {
        const resizer = document.getElementById('resizer')!;
        let isResizing = false;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizer.classList.add('resizing');
            document.body.style.cursor = 'col-resize';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const newWidth = document.body.clientWidth - e.clientX;
            if (newWidth > 150 && newWidth < 800) {
                document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                resizer.classList.remove('resizing');
                document.body.style.cursor = 'default';
            }
        });
    }

    requestImage(fileId: string, size: number): Promise<Blob> {
        return new Promise((resolve) => {
            const requestId = this.nextRequestId++;
            this.requestMap.set(requestId, resolve);
            
            const payload = { requestId, fileId, size };
            if (this.isConnected && this.ws) {
                this.ws.send(JSON.stringify(payload));
            } else {
                this.pendingRequests.push(payload);
            }
        });
    }

    processPending() {
        while (this.pendingRequests.length > 0 && this.isConnected && this.ws) {
            const req = this.pendingRequests.shift();
            if (req) this.ws.send(JSON.stringify(req));
        }
    }
}

new PhotoApp();
