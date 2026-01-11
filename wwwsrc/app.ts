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
    private selectedId: string | null = null;

    constructor() {
        this.init();
        this.setupModal();
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
            const photos: Photo[] = await res.json();
            this.renderGrid(photos);
        } catch (e) {
            console.error("Failed to load photos", e);
        }
    }

    renderGrid(photos: Photo[]) {
        const app = document.getElementById('app');
        if (!app) return;
        app.innerHTML = '';

        photos.forEach(p => {
            const card = document.createElement('div');
            card.className = 'card';
            card.dataset.id = p.id;
            
            const imgContainer = document.createElement('div');
            imgContainer.className = 'img-container';
            const spinner = document.createElement('div');
            spinner.className = 'spinner';
            imgContainer.appendChild(spinner);
            
            const img = document.createElement('img');
            img.alt = p.fileName;
            imgContainer.appendChild(img);

            // Lazy load 300px preview
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        this.requestImage(p.id, 300).then(blob => {
                            img.src = URL.createObjectURL(blob);
                            img.onload = () => {
                                imgContainer.classList.add('loaded');
                                spinner.remove();
                            };
                        });
                        observer.unobserve(card);
                    }
                });
            });
            observer.observe(card);

            const info = document.createElement('div');
            info.className = 'info';
            info.innerHTML = `
                <div>${p.fileName}</div>
                <div class='date'>${new Date(p.createdAt).toLocaleDateString()}</div>
            `;

            card.appendChild(imgContainer);
            card.appendChild(info);

            // Events
            card.addEventListener('click', () => this.selectPhoto(p, card));
            card.addEventListener('dblclick', () => this.openModal(p));

            app.appendChild(card);
        });
    }

    selectPhoto(photo: Photo, cardElement: HTMLElement) {
        // UI Selection
        if (this.selectedId) {
            const prev = document.querySelector(`.card[data-id="${this.selectedId}"]`);
            if (prev) prev.classList.remove('selected');
        }
        this.selectedId = photo.id;
        cardElement.classList.add('selected');

        // Load Metadata
        this.loadMetadata(photo);
    }

    async loadMetadata(photo: Photo) {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        
        sidebar.innerHTML = '<div class="no-selection">Loading metadata...</div>';

        try {
            const res = await fetch(`/api/metadata/${photo.id}`);
            const meta: MetadataItem[] = await res.json();
            
            // Group by Directory
            const groups: { [key: string]: MetadataItem[] } = {};
            meta.forEach(m => {
                const dir = m.directory || 'Unknown';
                if (!groups[dir]) groups[dir] = [];
                groups[dir].push(m);
            });

            let html = `<h2>${photo.fileName}</h2>`;
            
            // Basic Info
            html += `
                <div class="meta-group">
                    <h3>File Info</h3>
                    <div class="meta-row"><span class="meta-key">Created</span><span class="meta-val">${new Date(photo.createdAt).toLocaleString()}</span></div>
                </div>
            `;

            for (const dir of Object.keys(groups)) {
                html += `<div class="meta-group"><h3>${dir}</h3>`;
                groups[dir].forEach(m => {
                    html += `<div class="meta-row"><span class="meta-key">${m.tag}</span><span class="meta-val">${m.value}</span></div>`;
                });
                html += `</div>`;
            }

            sidebar.innerHTML = html;
        } catch (e) {
            sidebar.innerHTML = '<div class="no-selection">Failed to load metadata</div>';
        }
    }

    requestImage(fileId: string, size: number): Promise<Blob> {
        return new Promise((resolve, reject) => {
            const requestId = this.nextRequestId++;
            this.requestMap.set(requestId, resolve);
            
            const payload: ImageRequest = { requestId, fileId, size };
            
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
            if (req) {
                this.ws.send(JSON.stringify(req));
            }
        }
    }

    setupModal() {
        const modal = document.getElementById('modal');
        const closeBtn = document.querySelector('.modal-close');
        
        if (!modal || !closeBtn) return;

        const close = () => {
            modal.classList.remove('active');
            const img = document.getElementById('modal-img') as HTMLImageElement;
            if (img) img.src = ''; // Clear memory
        };

        closeBtn.addEventListener('click', close);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
        });
    }

    openModal(photo: Photo) {
        const modal = document.getElementById('modal');
        const img = document.getElementById('modal-img') as HTMLImageElement;
        const spinner = document.getElementById('modal-spinner');
        
        if (!modal || !img || !spinner) return;

        modal.classList.add('active');
        img.style.display = 'none';
        spinner.style.display = 'block';

        this.requestImage(photo.id, 1024).then(blob => {
            img.src = URL.createObjectURL(blob);
            img.onload = () => {
                img.style.display = 'block';
                spinner.style.display = 'none';
            };
        });
    }
}

new PhotoApp();