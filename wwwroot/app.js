"use strict";
class PhotoApp {
    constructor() {
        this.ws = null;
        this.requestMap = new Map();
        this.nextRequestId = 1;
        this.isConnected = false;
        this.pendingRequests = [];
        this.selectedId = null;
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
    updateStatus(connected) {
        const el = document.getElementById('connection-status');
        if (el) {
            el.innerText = connected ? 'Connected' : 'Disconnected';
            el.className = connected ? 'connected' : '';
        }
    }
    handleBinaryMessage(buffer) {
        const view = new DataView(buffer);
        const requestId = view.getInt32(0, true);
        const imageData = buffer.slice(4);
        if (this.requestMap.has(requestId)) {
            const blob = new Blob([imageData], { type: 'image/jpeg' });
            this.requestMap.get(requestId)(blob);
            this.requestMap.delete(requestId);
        }
    }
    async loadPhotos() {
        try {
            const res = await fetch('/api/photos');
            const photos = await res.json();
            this.renderGrid(photos);
        }
        catch (e) {
            console.error("Failed to load photos", e);
        }
    }
    renderGrid(photos) {
        const app = document.getElementById('app');
        if (!app)
            return;
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
    selectPhoto(photo, cardElement) {
        // UI Selection
        if (this.selectedId) {
            const prev = document.querySelector(`.card[data-id="${this.selectedId}"]`);
            if (prev)
                prev.classList.remove('selected');
        }
        this.selectedId = photo.id;
        cardElement.classList.add('selected');
        // Load Metadata
        this.loadMetadata(photo);
    }
    async loadMetadata(photo) {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar)
            return;
        sidebar.innerHTML = '<div class="no-selection">Loading metadata...</div>';
        try {
            const res = await fetch(`/api/metadata/${photo.id}`);
            const meta = await res.json();
            // Group by Directory
            const groups = {};
            meta.forEach(m => {
                const dir = m.directory || 'Unknown';
                if (!groups[dir])
                    groups[dir] = [];
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
        }
        catch (e) {
            sidebar.innerHTML = '<div class="no-selection">Failed to load metadata</div>';
        }
    }
    requestImage(fileId, size) {
        return new Promise((resolve, reject) => {
            const requestId = this.nextRequestId++;
            this.requestMap.set(requestId, resolve);
            const payload = { requestId, fileId, size };
            if (this.isConnected && this.ws) {
                this.ws.send(JSON.stringify(payload));
            }
            else {
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
        if (!modal || !closeBtn)
            return;
        const close = () => {
            modal.classList.remove('active');
            const img = document.getElementById('modal-img');
            if (img)
                img.src = ''; // Clear memory
        };
        closeBtn.addEventListener('click', close);
        modal.addEventListener('click', (e) => {
            if (e.target === modal)
                close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape')
                close();
        });
    }
    openModal(photo) {
        const modal = document.getElementById('modal');
        const img = document.getElementById('modal-img');
        const spinner = document.getElementById('modal-spinner');
        if (!modal || !img || !spinner)
            return;
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
