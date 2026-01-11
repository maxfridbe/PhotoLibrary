interface Photo {
    id: string;
    fileName: string;
    createdAt: string;
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

    constructor() {
        this.init();
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
            setTimeout(() => this.connectWs(), 2000); // Reconnect
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
        // Protocol: [4 bytes requestId (int32 little endian)] [Image Data]
        const view = new DataView(buffer);
        const requestId = view.getInt32(0, true); // Little endian
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
            
            const imgContainer = document.createElement('div');
            imgContainer.className = 'img-container';
            const spinner = document.createElement('div');
            spinner.className = 'spinner';
            imgContainer.appendChild(spinner);
            
            const img = document.createElement('img');
            img.alt = p.fileName;
            imgContainer.appendChild(img);

            // Lazy load logic
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
            app.appendChild(card);
        });
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
}

new PhotoApp();
