"use strict";
class App {
    constructor() {
        this.ws = null;
        this.requestMap = new Map();
        this.nextRequestId = 1;
        this.isConnected = false;
        this.pendingRequests = [];
        // State
        this.photos = [];
        this.photoMap = new Map();
        this.selectedId = null;
        this.selectedRootId = null;
        this.filterStarred = false;
        this.isLoupeMode = false;
        // Components
        this.libraryEl = null;
        this.workspaceEl = null;
        this.metadataEl = null;
        // Workspace Elements
        this.gridView = null;
        this.loupeView = null;
        this.filmstrip = null;
        this.mainPreview = null;
        this.previewSpinner = null;
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
        this.layout.registerComponent('library', function (container, state) {
            self.libraryEl = document.createElement('div');
            self.libraryEl.className = 'tree-view gl-component';
            container.getElement().append(self.libraryEl);
            if (self.photos.length > 0)
                self.loadData();
        });
        this.layout.registerComponent('workspace', function (container, state) {
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
            self.mainPreview = self.workspaceEl.querySelector('#main-preview');
            self.previewSpinner = self.workspaceEl.querySelector('#preview-spinner');
            container.getElement().get(0).addEventListener('keydown', (e) => {
                if (e.key.toLowerCase() === 'g')
                    self.enterGridMode();
                if (e.key.toLowerCase() === 'p')
                    self.toggleStar(self.selectedId);
            });
            self.workspaceEl.tabIndex = 0;
            if (self.photos.length > 0)
                self.renderGrid();
        });
        this.layout.registerComponent('metadata', function (container, state) {
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
            const roots = await rootsRes.json();
            this.photos = await photosRes.json();
            this.photoMap = new Map(this.photos.map(p => [p.id, p]));
            this.renderLibrary(roots);
            this.renderGrid();
        }
        catch (e) {
            console.error("Load failed", e);
        }
    }
    // --- Library Tree ---
    renderLibrary(roots) {
        if (!this.libraryEl)
            return;
        this.libraryEl.innerHTML = '';
        // Starred Node
        const starredBtn = document.createElement('div');
        starredBtn.className = 'tree-item';
        starredBtn.innerText = '★ Starred';
        starredBtn.onclick = () => this.filterByRoot(null, starredBtn, true);
        this.libraryEl.appendChild(starredBtn);
        // All Photos
        const allBtn = document.createElement('div');
        allBtn.className = 'tree-item selected';
        allBtn.innerText = 'All Photos';
        allBtn.onclick = () => this.filterByRoot(null, allBtn, false);
        this.libraryEl.appendChild(allBtn);
        // Directory Tree
        const map = new Map();
        roots.forEach(r => map.set(r.id, { node: r, children: [] }));
        const tree = [];
        roots.forEach(r => {
            if (r.parentId && map.has(r.parentId))
                map.get(r.parentId).children.push(map.get(r.id));
            else
                tree.push(map.get(r.id));
        });
        const renderNode = (item, container) => {
            const el = document.createElement('div');
            el.className = 'tree-item';
            el.innerText = item.node.name;
            el.onclick = () => this.filterByRoot(item.node.id, el, false);
            container.appendChild(el);
            if (item.children.length > 0) {
                const childContainer = document.createElement('div');
                childContainer.className = 'tree-children';
                item.children.forEach((c) => renderNode(c, childContainer));
                container.appendChild(childContainer);
            }
        };
        tree.forEach(t => renderNode(t, this.libraryEl));
    }
    filterByRoot(rootId, el, starredOnly) {
        var _a;
        const current = (_a = this.libraryEl) === null || _a === void 0 ? void 0 : _a.querySelector('.selected');
        if (current)
            current.classList.remove('selected');
        el.classList.add('selected');
        this.selectedRootId = rootId;
        this.filterStarred = starredOnly;
        this.renderGrid();
        if (this.isLoupeMode)
            this.renderFilmstrip();
    }
    getFilteredPhotos() {
        let list = this.photos;
        if (this.filterStarred) {
            list = list.filter(p => p.isStarred);
        }
        else if (this.selectedRootId) {
            list = list.filter(p => p.rootPathId === this.selectedRootId);
        }
        return list;
    }
    // --- Workspace ---
    renderGrid() {
        if (!this.gridView)
            return;
        this.gridView.innerHTML = '';
        const photos = this.getFilteredPhotos();
        photos.forEach(p => {
            const card = this.createCard(p, 'grid');
            this.gridView.appendChild(card);
        });
    }
    renderFilmstrip() {
        if (!this.filmstrip)
            return;
        this.filmstrip.innerHTML = '';
        const photos = this.getFilteredPhotos();
        photos.forEach(p => {
            const card = this.createCard(p, 'filmstrip');
            this.filmstrip.appendChild(card);
        });
        if (this.selectedId) {
            const el = this.filmstrip.querySelector(`.card[data-id="${this.selectedId}"]`);
            if (el)
                el.scrollIntoView({ behavior: 'auto', inline: 'center' });
        }
    }
    createCard(p, type) {
        const card = document.createElement('div');
        card.className = 'card';
        if (this.selectedId === p.id)
            card.classList.add('selected');
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
            const nameSpan = document.createElement('span');
            nameSpan.innerText = p.fileName;
            const starBtn = document.createElement('span');
            starBtn.className = `star-btn ${p.isStarred ? 'starred' : ''}`;
            starBtn.innerHTML = '★';
            starBtn.title = 'Toggle Star';
            starBtn.onclick = (e) => {
                e.stopPropagation();
                this.toggleStar(p.id);
            };
            info.appendChild(nameSpan);
            info.appendChild(starBtn);
            card.appendChild(info);
            card.addEventListener('dblclick', () => this.enterLoupeMode(p.id));
        }
        card.addEventListener('click', () => this.selectPhoto(p.id));
        return card;
    }
    lazyLoadImage(id, img, size) {
        const target = img.parentElement || img;
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    this.requestImage(id, size).then(blob => {
                        img.onload = () => { var _a; return (_a = img.parentElement) === null || _a === void 0 ? void 0 : _a.classList.add('loaded'); };
                        img.src = URL.createObjectURL(blob);
                    });
                    observer.disconnect();
                }
            });
        });
        observer.observe(target);
    }
    selectPhoto(id) {
        var _a, _b;
        if (this.selectedId === id)
            return;
        const oldSel = (_a = this.workspaceEl) === null || _a === void 0 ? void 0 : _a.querySelectorAll('.card.selected');
        oldSel === null || oldSel === void 0 ? void 0 : oldSel.forEach(e => e.classList.remove('selected'));
        this.selectedId = id;
        const newSel = (_b = this.workspaceEl) === null || _b === void 0 ? void 0 : _b.querySelectorAll(`.card[data-id="${id}"]`);
        newSel === null || newSel === void 0 ? void 0 : newSel.forEach(e => e.classList.add('selected'));
        this.loadMetadata(id);
        if (this.isLoupeMode)
            this.loadMainPreview(id);
    }
    enterLoupeMode(id) {
        this.isLoupeMode = true;
        this.gridView.style.display = 'none';
        this.loupeView.style.display = 'flex';
        this.renderFilmstrip();
        this.selectPhoto(id);
        this.loadMainPreview(id);
    }
    enterGridMode() {
        var _a;
        this.isLoupeMode = false;
        this.loupeView.style.display = 'none';
        this.gridView.style.display = 'grid';
        if (this.selectedId) {
            const el = (_a = this.gridView) === null || _a === void 0 ? void 0 : _a.querySelector(`.card[data-id="${this.selectedId}"]`);
            el === null || el === void 0 ? void 0 : el.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
    }
    loadMainPreview(id) {
        if (!this.mainPreview)
            return;
        this.mainPreview.style.display = 'none';
        this.previewSpinner.style.display = 'block';
        this.requestImage(id, 1024).then(blob => {
            if (this.selectedId === id) {
                this.mainPreview.src = URL.createObjectURL(blob);
                this.mainPreview.style.display = 'block';
                this.previewSpinner.style.display = 'none';
            }
        });
    }
    async loadMetadata(id) {
        if (!this.metadataEl)
            return;
        const photo = this.photoMap.get(id);
        if (!photo)
            return;
        this.metadataEl.innerHTML = 'Loading...';
        try {
            const res = await fetch(`/api/metadata/${id}`);
            const meta = await res.json();
            let html = `<h2>${photo.fileName} ${photo.isStarred ? '★' : ''}</h2>`;
            const groups = {};
            meta.forEach(m => {
                const k = m.directory || 'Unknown';
                if (!groups[k])
                    groups[k] = [];
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
        }
        catch (_a) {
            this.metadataEl.innerHTML = 'Error';
        }
    }
    async toggleStar(id) {
        var _a;
        if (!id)
            return;
        const photo = this.photoMap.get(id);
        if (!photo)
            return;
        photo.isStarred = !photo.isStarred;
        // Optimistic UI update
        const stars = (_a = this.workspaceEl) === null || _a === void 0 ? void 0 : _a.querySelectorAll(`.card[data-id="${id}"] .star-btn`);
        stars === null || stars === void 0 ? void 0 : stars.forEach(s => {
            if (photo.isStarred)
                s.classList.add('starred');
            else
                s.classList.remove('starred');
        });
        // Refresh metadata panel if selected
        if (this.selectedId === id)
            this.loadMetadata(id);
        try {
            await fetch(`/api/star/${id}?isStarred=${photo.isStarred}`, { method: 'POST' });
        }
        catch (e) {
            console.error('Failed to save star status');
            photo.isStarred = !photo.isStarred; // Revert
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
    handleBinaryMessage(buffer) {
        const view = new DataView(buffer);
        const reqId = view.getInt32(0, true);
        const data = buffer.slice(4);
        if (this.requestMap.has(reqId)) {
            this.requestMap.get(reqId)(new Blob([data], { type: 'image/jpeg' }));
            this.requestMap.delete(reqId);
        }
    }
    requestImage(fileId, size) {
        return new Promise(resolve => {
            const requestId = this.nextRequestId++;
            this.requestMap.set(requestId, resolve);
            const payload = { requestId, fileId, size };
            if (this.isConnected && this.ws)
                this.ws.send(JSON.stringify(payload));
            else
                this.pendingRequests.push(payload);
        });
    }
    processPending() {
        var _a;
        while (this.pendingRequests.length && this.isConnected) {
            (_a = this.ws) === null || _a === void 0 ? void 0 : _a.send(JSON.stringify(this.pendingRequests.shift()));
        }
    }
}
// Global shortcut support
document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'g') {
        window.app.enterGridMode();
    }
});
window.app = new App();
