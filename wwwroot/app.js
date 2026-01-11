import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
import { server } from './serverOperations.js';
class App {
    constructor() {
        this.photos = [];
        this.photoMap = new Map();
        this.roots = [];
        this.userCollections = [];
        this.stats = { totalCount: 0, pickedCount: 0, ratingCounts: [0, 0, 0, 0, 0] };
        this.totalPhotos = 0;
        this.selectedId = null;
        this.selectedRootId = null;
        this.selectedCollectionId = null;
        this.filterType = 'all';
        this.filterRating = 0;
        this.searchResultIds = [];
        this.searchTitle = '';
        this.collectionFiles = [];
        this.rowHeight = 230;
        this.minCardWidth = 210;
        this.cols = 1;
        this.visibleRange = { start: 0, end: 0 };
        this.isLoadingChunk = new Set();
        this.isLoupeMode = false;
        this.libraryEl = null;
        this.workspaceEl = null;
        this.metadataEl = null;
        this.gridHeader = null;
        this.gridView = null;
        this.scrollSentinel = null;
        this.loupeView = null;
        this.filmstrip = null;
        this.mainPreview = null;
        this.previewSpinner = null;
        this.initLayout();
        this.loadData();
        this.setupGlobalKeyboard();
        this.setupContextMenu();
        this.initPubSub();
    }
    initPubSub() {
        hub.sub('photo.selected', (data) => {
            this.selectedId = data.id;
            this.updateSelectionUI(data.id);
            this.loadMetadata(data.id);
            if (this.isLoupeMode)
                this.loadMainPreview(data.id);
        });
        hub.sub('view.mode.changed', (data) => {
            this.isLoupeMode = data.mode === 'loupe';
            this.updateViewModeUI();
            if (data.mode === 'loupe' && data.id) {
                hub.pub('photo.selected', { id: data.id, photo: this.photoMap.get(data.id) });
            }
        });
        hub.sub('photo.updated', (data) => {
            this.handlePhotoUpdate(data.photo);
        });
        hub.subPattern('photo.picked.*', () => this.refreshStatsOnly());
        hub.subPattern('photo.starred.*', () => this.refreshStatsOnly());
        hub.sub('search.triggered', (data) => this.searchPhotos(data.tag, data.value));
        hub.sub('shortcuts.show', () => document.getElementById('shortcuts-modal')?.classList.add('active'));
        hub.sub('ui.layout.changed', () => this.updateVirtualGrid());
        hub.sub('connection.changed', (data) => this.updateStatusUI(data.connected, data.connecting));
        hub.sub('ui.notification', (data) => this.showNotification(data.message, data.type));
    }
    handlePhotoUpdate(photo) {
        this.photoMap.set(photo.id, photo);
        const idx = this.photos.findIndex(p => p?.id === photo.id);
        let stillPasses = true;
        if (this.filterType === 'picked' && !photo.isPicked)
            stillPasses = false;
        else if (this.filterType === 'rating' && photo.rating !== this.filterRating)
            stillPasses = false;
        else if (this.selectedRootId && photo.rootPathId !== this.selectedRootId)
            stillPasses = false;
        if (stillPasses) {
            if (idx !== -1)
                this.photos[idx] = photo;
            this.updatePhotoCardUI(photo);
        }
        else {
            if (idx !== -1) {
                this.photos.splice(idx, 1);
                this.totalPhotos--;
                this.renderGrid();
                if (this.isLoupeMode)
                    this.renderFilmstrip();
                if (this.selectedId === photo.id) {
                    const nextId = this.photos[idx]?.id || this.photos[idx - 1]?.id || null;
                    if (nextId) {
                        const nextPhoto = this.photoMap.get(nextId);
                        if (nextPhoto)
                            hub.pub('photo.selected', { id: nextId, photo: nextPhoto });
                    }
                    else {
                        this.selectedId = null;
                        if (this.metadataEl)
                            this.metadataEl.innerHTML = '';
                    }
                }
            }
        }
        if (this.selectedId === photo.id)
            this.loadMetadata(photo.id);
    }
    showNotification(message, type) {
        const container = document.getElementById('notifications');
        if (!container)
            return;
        const el = document.createElement('div');
        el.style.padding = '10px 20px';
        el.style.borderRadius = '4px';
        el.style.color = '#fff';
        el.style.fontSize = '0.9em';
        el.style.boxShadow = '0 4px 10px rgba(0,0,0,0.3)';
        el.style.background = type === 'error' ? '#d32f2f' : (type === 'success' ? '#388e3c' : '#1976d2');
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transition = 'opacity 0.5s';
            setTimeout(() => el.remove(), 500);
        }, 3000);
    }
    updateStatusUI(connected, connecting = false) {
        const el = document.getElementById('connection-status');
        if (el) {
            if (connecting) {
                el.innerHTML = '';
                const s = document.createElement('span');
                s.className = 'spinner';
                s.style.display = 'inline-block';
                s.style.width = '10px';
                s.style.height = '10px';
                s.style.verticalAlign = 'middle';
                s.style.marginRight = '5px';
                el.appendChild(s);
                el.appendChild(document.createTextNode(' Connecting...'));
                el.style.color = '#aaa';
            }
            else if (connected) {
                el.textContent = 'Connected';
                el.style.color = '#0f0';
            }
            else {
                el.textContent = 'Disconnected';
                el.style.color = '#f00';
            }
        }
    }
    async refreshStatsOnly() {
        this.stats = await Api.api_stats({});
        this.updateSidebarCountsOnly();
    }
    updateSidebarCountsOnly() {
        if (!this.libraryEl)
            return;
        const allPhotosCountEl = this.libraryEl.querySelector('.tree-item[data-type="all"] .count');
        if (allPhotosCountEl)
            allPhotosCountEl.textContent = this.stats.totalCount.toString();
        const pickedCountEl = this.libraryEl.querySelector('.tree-item[data-type="picked"] .count');
        if (pickedCountEl)
            pickedCountEl.textContent = this.stats.pickedCount.toString();
        for (let i = 1; i <= 5; i++) {
            const countEl = this.libraryEl.querySelector(`.tree-item[data-type="rating-${i}"] .count`);
            if (countEl)
                countEl.textContent = this.stats.ratingCounts[i - 1].toString();
        }
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
        }
        catch (e) {
            console.error("Load failed", e);
        }
    }
    async refreshPhotos() {
        this.photos = [];
        this.isLoadingChunk.clear();
        const params = {
            limit: 100, offset: 0,
            rootId: this.selectedRootId || undefined,
            pickedOnly: this.filterType === 'picked',
            rating: this.filterRating,
            specificIds: (this.filterType === 'collection' ? this.collectionFiles : (this.filterType === 'search' ? this.searchResultIds : undefined))
        };
        const [data, stats] = await Promise.all([Api.api_photos(params), Api.api_stats({})]);
        this.totalPhotos = data.total;
        this.stats = stats;
        this.photos = new Array(this.totalPhotos).fill(null);
        data.photos.forEach((p, i) => { this.photos[i] = p; this.photoMap.set(p.id, p); });
        this.renderLibrary();
        this.renderGrid();
        if (this.isLoupeMode)
            this.renderFilmstrip();
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
        this.layout.registerComponent('library', function (container) {
            self.libraryEl = document.createElement('div');
            self.libraryEl.className = 'tree-view gl-component';
            container.getElement().append(self.libraryEl);
            if (self.photos.length > 0)
                self.renderLibrary();
        });
        this.layout.registerComponent('workspace', function (container) {
            self.workspaceEl = document.createElement('div');
            self.workspaceEl.className = 'gl-component';
            self.workspaceEl.style.overflow = 'hidden';
            const header = document.createElement('div');
            header.id = 'grid-header';
            header.className = 'grid-header';
            const headerText = document.createElement('span');
            headerText.id = 'header-text';
            headerText.textContent = 'All Photos';
            const headerCount = document.createElement('span');
            headerCount.id = 'header-count';
            headerCount.textContent = '0 items';
            header.appendChild(headerText);
            header.appendChild(headerCount);
            self.workspaceEl.appendChild(header);
            const gridContainer = document.createElement('div');
            gridContainer.id = 'grid-container';
            gridContainer.style.flex = '1';
            gridContainer.style.overflowY = 'auto';
            gridContainer.style.position = 'relative';
            const sentinel = document.createElement('div');
            sentinel.id = 'scroll-sentinel';
            sentinel.style.position = 'absolute';
            sentinel.style.top = '0';
            sentinel.style.left = '0';
            sentinel.style.right = '0';
            sentinel.style.height = '0';
            sentinel.style.pointerEvents = 'none';
            const gridView = document.createElement('div');
            gridView.id = 'grid-view';
            gridView.className = 'grid-view';
            gridView.style.position = 'absolute';
            gridView.style.top = '0';
            gridView.style.left = '0';
            gridView.style.right = '0';
            gridContainer.appendChild(sentinel);
            gridContainer.appendChild(gridView);
            self.workspaceEl.appendChild(gridContainer);
            const loupeView = document.createElement('div');
            loupeView.id = 'loupe-view';
            loupeView.className = 'loupe-view';
            loupeView.style.display = 'none';
            loupeView.style.height = '100%';
            const previewArea = document.createElement('div');
            previewArea.className = 'preview-area';
            const spinner = document.createElement('div');
            spinner.className = 'spinner center-spinner';
            spinner.id = 'preview-spinner';
            const img = document.createElement('img');
            img.id = 'main-preview';
            previewArea.appendChild(spinner);
            previewArea.appendChild(img);
            const filmstrip = document.createElement('div');
            filmstrip.id = 'filmstrip';
            filmstrip.className = 'filmstrip';
            loupeView.appendChild(previewArea);
            loupeView.appendChild(filmstrip);
            self.workspaceEl.appendChild(loupeView);
            container.getElement().append(self.workspaceEl);
            self.gridHeader = header;
            self.gridView = gridView;
            self.scrollSentinel = sentinel;
            self.loupeView = loupeView;
            self.filmstrip = filmstrip;
            self.mainPreview = img;
            self.previewSpinner = spinner;
            gridContainer.onscroll = () => self.updateVirtualGrid();
            container.getElement().get(0).addEventListener('keydown', (e) => self.handleKey(e));
            self.workspaceEl.tabIndex = 0;
            if (self.photos.length > 0)
                self.renderGrid();
        });
        this.layout.registerComponent('metadata', function (container) {
            self.metadataEl = document.createElement('div');
            self.metadataEl.className = 'metadata-panel gl-component';
            container.getElement().append(self.metadataEl);
        });
        this.layout.init();
        window.addEventListener('resize', () => { this.layout.updateSize(); hub.pub('ui.layout.changed', {}); });
        this.layout.on('stateChanged', () => hub.pub('ui.layout.changed', {}));
    }
    updateSelectionUI(id) {
        const oldSel = this.workspaceEl?.querySelectorAll('.card.selected');
        oldSel?.forEach(e => e.classList.remove('selected'));
        const newSel = this.workspaceEl?.querySelectorAll(`.card[data-id="${id}"]`);
        newSel?.forEach(e => e.classList.add('selected'));
        if (this.isLoupeMode) {
            const stripItem = this.filmstrip?.querySelector(`.card[data-id="${id}"]`);
            if (stripItem)
                stripItem.scrollIntoView({ behavior: 'smooth', inline: 'center' });
        }
    }
    updateViewModeUI() {
        const gridCont = this.workspaceEl?.querySelector('#grid-container');
        if (this.isLoupeMode) {
            if (gridCont)
                gridCont.style.display = 'none';
            if (this.gridHeader)
                this.gridHeader.style.display = 'none';
            if (this.loupeView)
                this.loupeView.style.display = 'flex';
            document.getElementById('nav-grid')?.classList.remove('active');
            document.getElementById('nav-loupe')?.classList.add('active');
            this.renderFilmstrip();
        }
        else {
            if (this.loupeView)
                this.loupeView.style.display = 'none';
            if (gridCont)
                gridCont.style.display = 'flex';
            if (this.gridHeader)
                this.gridHeader.style.display = 'flex';
            document.getElementById('nav-loupe')?.classList.remove('active');
            document.getElementById('nav-grid')?.classList.add('active');
            this.updateVirtualGrid(true);
        }
    }
    updatePhotoCardUI(photo) {
        const cards = this.workspaceEl?.querySelectorAll(`.card[data-id="${photo.id}"]`);
        cards?.forEach(card => {
            const pBtn = card.querySelector('.pick-btn');
            if (pBtn) {
                if (photo.isPicked)
                    pBtn.classList.add('picked');
                else
                    pBtn.classList.remove('picked');
            }
            const stars = card.querySelector('.stars');
            if (stars) {
                const el = stars;
                el.textContent = '\u2605'.repeat(photo.rating) || '\u2606\u2606\u2606\u2606\u2606';
                if (photo.rating > 0)
                    el.classList.add('has-rating');
                else
                    el.classList.remove('has-rating');
            }
        });
    }
    updateVirtualGrid(force = false) {
        if (!this.gridView || !this.workspaceEl || this.isLoupeMode)
            return;
        const gridContainer = this.gridView.parentElement;
        const containerWidth = gridContainer.clientWidth - 20;
        this.cols = Math.max(1, Math.floor(containerWidth / this.minCardWidth));
        const rowCount = Math.ceil(this.totalPhotos / this.cols);
        const totalHeight = rowCount * this.rowHeight;
        this.scrollSentinel.style.height = totalHeight + 'px';
        const scrollTop = gridContainer.scrollTop;
        const viewHeight = gridContainer.clientHeight;
        const startRow = Math.floor(scrollTop / this.rowHeight);
        const endIndex = Math.min(this.totalPhotos, Math.ceil((scrollTop + viewHeight) / this.rowHeight + 1) * this.cols);
        const startIndex = Math.max(0, startRow * this.cols);
        if (force || startIndex !== this.visibleRange.start || endIndex !== this.visibleRange.end) {
            this.visibleRange = { start: startIndex, end: endIndex };
            this.renderVisiblePhotos();
        }
        this.checkMissingChunks(startIndex, endIndex);
    }
    renderVisiblePhotos() {
        if (!this.gridView)
            return;
        this.gridView.innerHTML = '';
        const startRow = Math.floor(this.visibleRange.start / this.cols);
        this.gridView.style.transform = `translateY(${startRow * this.rowHeight}px)`;
        for (let i = this.visibleRange.start; i < this.visibleRange.end; i++) {
            const photo = this.photos[i];
            if (photo)
                this.gridView.appendChild(this.createCard(photo, 'grid'));
            else {
                const placeholder = document.createElement('div');
                placeholder.className = 'card placeholder';
                placeholder.style.height = (this.rowHeight - 10) + 'px';
                const cont = document.createElement('div');
                cont.className = 'img-container';
                const spin = document.createElement('div');
                spin.className = 'spinner';
                cont.appendChild(spin);
                placeholder.appendChild(cont);
                this.gridView.appendChild(placeholder);
            }
        }
    }
    async checkMissingChunks(start, end) {
        const chunkSize = 100;
        const startChunk = Math.floor(start / chunkSize);
        const endChunk = Math.floor(end / chunkSize);
        for (let c = startChunk; c <= endChunk; c++) {
            const offset = c * chunkSize;
            if (!this.isLoadingChunk.has(offset) && !this.photos[offset])
                this.loadChunk(offset, chunkSize);
        }
    }
    async loadChunk(offset, limit) {
        this.isLoadingChunk.add(offset);
        try {
            const params = {
                limit, offset,
                rootId: this.selectedRootId || undefined,
                pickedOnly: this.filterType === 'picked',
                rating: this.filterRating,
                specificIds: (this.filterType === 'collection' ? this.collectionFiles : (this.filterType === 'search' ? this.searchResultIds : undefined))
            };
            const data = await Api.api_photos(params);
            data.photos.forEach((p, i) => { this.photos[offset + i] = p; this.photoMap.set(p.id, p); });
            this.renderVisiblePhotos();
        }
        finally {
            this.isLoadingChunk.delete(offset);
        }
    }
    renderLibrary() {
        if (!this.libraryEl)
            return;
        this.libraryEl.innerHTML = '';
        const createSection = (title) => {
            const el = document.createElement('div');
            el.className = 'tree-section-header';
            el.textContent = title;
            return el;
        };
        this.libraryEl.appendChild(createSection('Search'));
        const searchBox = document.createElement('div');
        searchBox.className = 'search-box';
        const searchInput = document.createElement('input');
        searchInput.className = 'search-input';
        searchInput.placeholder = 'Tag search...';
        searchInput.onkeydown = (e) => { if (e.key === 'Enter')
            hub.pub('search.triggered', { tag: 'FileName', value: searchInput.value }); };
        searchBox.appendChild(searchInput);
        this.libraryEl.appendChild(searchBox);
        if (this.filterType === 'search')
            this.addTreeItem(this.libraryEl, '\uD83D\uDD0D ' + this.searchTitle, this.searchResultIds.length, () => this.setFilter('search'), true, 'search');
        this.libraryEl.appendChild(createSection('Collections'));
        this.addTreeItem(this.libraryEl, 'All Photos', this.stats.totalCount, () => this.setFilter('all'), this.filterType === 'all' && !this.selectedRootId, 'all');
        const pEl = this.addTreeItem(this.libraryEl, '\u2691 Picked', this.stats.pickedCount, () => this.setFilter('picked'), this.filterType === 'picked', 'picked');
        pEl.oncontextmenu = (e) => { e.preventDefault(); this.showPickedContextMenu(e); };
        this.userCollections.forEach(c => {
            const el = this.addTreeItem(this.libraryEl, '\uD83D\uDCC1 ' + c.name, c.count, () => this.setCollectionFilter(c), this.selectedCollectionId === c.id, 'collection-' + c.id);
            el.oncontextmenu = (e) => { e.preventDefault(); this.showCollectionContextMenu(e, c); };
        });
        for (let i = 5; i >= 1; i--) {
            const count = this.stats.ratingCounts[i - 1];
            this.addTreeItem(this.libraryEl, '\u2605'.repeat(i), count, () => this.setFilter('rating', i), this.filterType === 'rating' && this.filterRating === i, 'rating-' + i);
        }
        this.libraryEl.appendChild(createSection('Folders'));
        const treeContainer = document.createElement('div');
        this.libraryEl.appendChild(treeContainer);
        const map = new Map();
        this.roots.forEach(r => map.set(r.id, { node: r, children: [] }));
        const tree = [];
        this.roots.forEach(r => { if (r.parentId && map.has(r.parentId))
            map.get(r.parentId).children.push(map.get(r.id));
        else
            tree.push(map.get(r.id)); });
        const renderNode = (item, container) => {
            this.addTreeItem(container, item.node.name, 0, () => this.setFilter('all', 0, item.node.id), this.selectedRootId === item.node.id, 'folder-' + item.node.id);
            if (item.children.length > 0) {
                const childContainer = document.createElement('div');
                childContainer.className = 'tree-children';
                item.children.forEach((c) => renderNode(c, childContainer));
                container.appendChild(childContainer);
            }
        };
        tree.forEach(t => renderNode(t, treeContainer));
    }
    addTreeItem(container, text, count, onClick, isSelected, typeAttr) {
        const el = document.createElement('div');
        el.className = 'tree-item' + (isSelected ? ' selected' : '');
        el.dataset.type = typeAttr;
        const s = document.createElement('span');
        s.textContent = text;
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = count > 0 ? count.toString() : '';
        el.appendChild(s);
        el.appendChild(c);
        el.onclick = onClick;
        container.appendChild(el);
        return el;
    }
    setFilter(type, rating = 0, rootId = null) {
        this.filterType = type;
        this.filterRating = rating;
        this.selectedRootId = rootId;
        this.selectedCollectionId = null;
        this.refreshPhotos();
    }
    async setCollectionFilter(c) {
        this.filterType = 'collection';
        this.selectedCollectionId = c.id;
        this.selectedRootId = null;
        this.collectionFiles = await Api.api_collections_get_files({ id: c.id });
        this.refreshPhotos();
    }
    setupContextMenu() { document.addEventListener('click', () => { const menu = document.getElementById('context-menu'); if (menu)
        menu.style.display = 'none'; }); }
    showPickedContextMenu(e) {
        const menu = document.getElementById('context-menu');
        menu.innerHTML = '';
        const addItem = (text, cb) => {
            const el = document.createElement('div');
            el.className = 'context-menu-item';
            el.textContent = text;
            el.onclick = cb;
            menu.appendChild(el);
        };
        addItem('Clear All Picked', () => this.clearAllPicked());
        const d = document.createElement('div');
        d.className = 'context-menu-divider';
        menu.appendChild(d);
        addItem('Store to new collection...', () => this.storePickedToCollection(null));
        this.userCollections.forEach(c => addItem(`Store to '${c.name}'`, () => this.storePickedToCollection(c.id)));
        menu.style.display = 'block';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
    }
    showCollectionContextMenu(e, c) {
        const menu = document.getElementById('context-menu');
        menu.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'context-menu-item';
        el.textContent = 'Remove Collection';
        el.onclick = () => this.deleteCollection(c.id);
        menu.appendChild(el);
        menu.style.display = 'block';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
    }
    async clearAllPicked() { await Api.api_picked_clear({}); this.refreshPhotos(); hub.pub('ui.notification', { message: 'Picked photos cleared', type: 'info' }); }
    async storePickedToCollection(id) {
        const pickedIds = await Api.api_picked_ids({});
        if (pickedIds.length === 0)
            return;
        if (id === null) {
            const name = prompt('New Collection Name:');
            if (!name)
                return;
            const res = await Api.api_collections_create({ name });
            id = res.id;
        }
        await Api.api_collections_add_files({ collectionId: id, fileIds: pickedIds });
        hub.pub('ui.notification', { message: 'Photos added to collection', type: 'success' });
        await this.refreshCollections();
    }
    async deleteCollection(id) {
        if (!confirm('Are you sure you want to remove this collection?'))
            return;
        await Api.api_collections_delete({ id });
        hub.pub('ui.notification', { message: 'Collection deleted', type: 'info' });
        if (this.selectedCollectionId === id)
            this.setFilter('all');
        else
            await this.refreshCollections();
    }
    async refreshCollections() { this.userCollections = await Api.api_collections_list({}); this.renderLibrary(); }
    async searchPhotos(tag, value) {
        this.searchResultIds = await Api.api_search({ tag, value });
        this.searchTitle = `${tag}: ${value}`;
        this.setFilter('search');
    }
    getFilteredPhotos() { return this.photos.filter(p => p !== null); }
    renderGrid() {
        this.updateVirtualGrid(true);
        let headerText = "All Photos";
        if (this.filterType === 'picked')
            headerText = "Collection: Picked";
        else if (this.filterType === 'rating')
            headerText = "Collection: Starred";
        else if (this.filterType === 'search')
            headerText = "Search: " + this.searchTitle;
        else if (this.filterType === 'collection') {
            const c = this.userCollections.find(x => x.id === this.selectedCollectionId);
            headerText = "Collection: " + (c?.name || "");
        }
        else if (this.selectedRootId) {
            const root = this.roots.find(r => r.id === this.selectedRootId);
            headerText = root ? `Folder: ${root.name}` : "Folder";
        }
        if (this.gridHeader) {
            const headerTextEl = this.gridHeader.querySelector('#header-text');
            if (headerTextEl) {
                headerTextEl.innerHTML = '';
                headerTextEl.appendChild(document.createTextNode('Showing '));
                const b = document.createElement('b');
                b.textContent = headerText;
                headerTextEl.appendChild(b);
            }
            const headerCountEl = this.gridHeader.querySelector('#header-count');
            if (headerCountEl)
                headerCountEl.textContent = `${this.totalPhotos} items`;
        }
    }
    renderFilmstrip() {
        if (!this.filmstrip)
            return;
        this.filmstrip.innerHTML = '';
        const loadedPhotos = this.getFilteredPhotos();
        loadedPhotos.forEach(p => this.filmstrip.appendChild(this.createCard(p, 'filmstrip')));
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
            const top = document.createElement('div');
            top.className = 'info-top';
            const name = document.createElement('span');
            name.textContent = p.fileName || '';
            const pick = document.createElement('span');
            pick.className = 'pick-btn' + (p.isPicked ? ' picked' : '');
            pick.textContent = '\u2691';
            pick.onclick = (e) => { e.stopPropagation(); server.togglePick(p); };
            top.appendChild(name);
            top.appendChild(pick);
            const bottom = document.createElement('div');
            bottom.className = 'info-bottom';
            const stars = document.createElement('span');
            stars.className = 'stars' + (p.rating > 0 ? ' has-rating' : '');
            stars.textContent = '\u2605'.repeat(p.rating) || '\u2606\u2606\u2606\u2606\u2606';
            bottom.appendChild(stars);
            info.appendChild(top);
            info.appendChild(bottom);
            card.appendChild(info);
            card.addEventListener('dblclick', () => hub.pub('view.mode.changed', { mode: 'loupe', id: p.id }));
        }
        card.addEventListener('click', () => hub.pub('photo.selected', { id: p.id, photo: p }));
        return card;
    }
    lazyLoadImage(id, img, size) {
        const target = img.parentElement || img;
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    server.requestImage(id, size).then(blob => {
                        img.onload = () => img.parentElement?.classList.add('loaded');
                        img.src = URL.createObjectURL(blob);
                    });
                    observer.disconnect();
                }
            });
        });
        observer.observe(target);
    }
    selectPhoto(id) {
        if (this.selectedId === id)
            return;
        const oldSel = this.workspaceEl?.querySelectorAll('.card.selected');
        oldSel?.forEach(e => e.classList.remove('selected'));
        this.selectedId = id;
        const newSel = this.workspaceEl?.querySelectorAll(`.card[data-id="${id}"]`);
        newSel?.forEach(e => e.classList.add('selected'));
        this.loadMetadata(id);
        if (this.isLoupeMode)
            this.loadMainPreview(id);
    }
    enterLoupeMode(id) {
        this.isLoupeMode = true;
        if (this.workspaceEl) {
            const cont = this.workspaceEl.querySelector('#grid-container');
            if (cont)
                cont.style.display = 'none';
        }
        if (this.gridHeader)
            this.gridHeader.style.display = 'none';
        if (this.loupeView)
            this.loupeView.style.display = 'flex';
        document.getElementById('nav-grid')?.classList.remove('active');
        document.getElementById('nav-loupe')?.classList.add('active');
        this.renderFilmstrip();
        this.selectPhoto(id);
        this.loadMainPreview(id);
    }
    enterGridMode() {
        this.isLoupeMode = false;
        if (this.loupeView)
            this.loupeView.style.display = 'none';
        if (this.workspaceEl) {
            const cont = this.workspaceEl.querySelector('#grid-container');
            if (cont)
                cont.style.display = 'flex';
        }
        if (this.gridHeader)
            this.gridHeader.style.display = 'flex';
        document.getElementById('nav-loupe')?.classList.remove('active');
        document.getElementById('nav-grid')?.classList.add('active');
        if (this.selectedId) {
            const index = this.photos.findIndex(p => p?.id === this.selectedId);
            if (index !== -1) {
                const row = Math.floor(index / this.cols);
                const cont = this.gridView?.parentElement;
                if (cont)
                    cont.scrollTop = row * this.rowHeight - (cont.clientHeight / 2) + (this.rowHeight / 2);
            }
        }
        this.updateVirtualGrid(true);
    }
    loadMainPreview(id) {
        if (!this.mainPreview)
            return;
        this.mainPreview.style.display = 'none';
        if (this.previewSpinner)
            this.previewSpinner.style.display = 'block';
        server.requestImage(id, 1024).then(blob => {
            if (this.selectedId === id) {
                this.mainPreview.src = URL.createObjectURL(blob);
                this.mainPreview.style.display = 'block';
                if (this.previewSpinner)
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
        const priorityTags = ['Exposure Time', 'Shutter Speed Value', 'F-Number', 'Aperture Value', 'Max Aperture Value', 'ISO Speed Rating', 'ISO', 'Focal Length', 'Focal Length 35', 'Lens Model', 'Lens', 'Model', 'Make', 'Exposure Bias Value', 'Exposure Mode', 'Exposure Program', 'Focus Mode', 'Image Stabilisation', 'Metering Mode', 'White Balance', 'Flash', 'Color Temperature', 'Quality', 'Created', 'Size', 'Image Width', 'Image Height', 'Exif Image Width', 'Exif Image Height', 'Software', 'Orientation', 'ID'];
        const groupOrder = ['File Info', 'Exif SubIF', 'Exif IFD0', 'Sony Maker', 'GPS', 'XMP'];
        this.metadataEl.innerHTML = '';
        try {
            const meta = await Api.api_metadata({ id });
            const groups = {};
            meta.forEach(m => { const k = m.directory || 'Unknown'; if (!groups[k])
                groups[k] = []; groups[k].push(m); });
            groups['File Info'] = [
                { directory: 'File Info', tag: 'Created', value: new Date(photo.createdAt).toLocaleString() },
                { directory: 'File Info', tag: 'Size', value: (photo.size / (1024 * 1024)).toFixed(2) + ' MB' },
                { directory: 'File Info', tag: 'ID', value: id }
            ];
            const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
                const getMinPriority = (g) => { const priorities = groups[g].map(i => priorityTags.indexOf(i.tag)).filter(p => p !== -1); return priorities.length > 0 ? Math.min(...priorities) : 999; };
                const pa = getMinPriority(a);
                const pb = getMinPriority(b);
                if (pa !== pb)
                    return pa - pb;
                let ia = groupOrder.indexOf(a);
                let ib = groupOrder.indexOf(b);
                if (ia === -1)
                    ia = 999;
                if (ib === -1)
                    ib = 999;
                return ia - ib;
            });
            const pickText = photo.isPicked ? '\u2691' : '';
            const starsText = photo.rating > 0 ? '\u2605'.repeat(photo.rating) : '';
            const title = document.createElement('h2');
            title.textContent = `${photo.fileName} ${pickText} ${starsText}`;
            this.metadataEl.appendChild(title);
            for (const k of sortedGroupKeys) {
                const items = groups[k];
                items.sort((a, b) => { let ia = priorityTags.indexOf(a.tag); let ib = priorityTags.indexOf(b.tag); if (ia === -1)
                    ia = 999; if (ib === -1)
                    ib = 999; if (ia !== ib)
                    return ia - ib; return a.tag.localeCompare(b.tag); });
                const groupDiv = document.createElement('div');
                groupDiv.className = 'meta-group';
                const h3 = document.createElement('h3');
                h3.textContent = k;
                groupDiv.appendChild(h3);
                items.forEach(m => {
                    const row = document.createElement('div');
                    row.className = 'meta-row';
                    const key = document.createElement('span');
                    key.className = 'meta-key';
                    key.textContent = m.tag || '';
                    const val = document.createElement('span');
                    val.className = 'meta-val';
                    val.textContent = m.value || '';
                    const search = document.createElement('span');
                    search.className = 'meta-search-btn';
                    search.textContent = '\uD83D\uDD0D';
                    search.title = 'Search';
                    search.onclick = () => hub.pub('search.triggered', { tag: m.tag, value: m.value });
                    row.appendChild(key);
                    row.appendChild(val);
                    row.appendChild(search);
                    groupDiv.appendChild(row);
                });
                this.metadataEl.appendChild(groupDiv);
            }
        }
        catch {
            this.metadataEl.textContent = 'Error';
        }
    }
    handleKey(e) {
        const key = e.key.toLowerCase();
        if (key === 'g')
            hub.pub('view.mode.changed', { mode: 'grid' });
        if (key === 'l') {
            if (this.selectedId)
                hub.pub('view.mode.changed', { mode: 'loupe', id: this.selectedId });
        }
        if (key === 'p') {
            if (this.selectedId) {
                const p = this.photoMap.get(this.selectedId);
                if (p)
                    server.togglePick(p);
            }
        }
        if (key >= '0' && key <= '5') {
            if (this.selectedId) {
                const p = this.photoMap.get(this.selectedId);
                if (p)
                    server.setRating(p, parseInt(key));
            }
        }
        if (key === '?' || key === '/') {
            if (key === '?' || (key === '/' && e.shiftKey)) {
                e.preventDefault();
                hub.pub('shortcuts.show', {});
            }
        }
        if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(e.key.toLowerCase())) {
            e.preventDefault();
            this.navigate(e.key);
        }
    }
    navigate(key) {
        const photos = this.photos.filter(p => p !== null);
        if (photos.length === 0)
            return;
        let index = this.selectedId ? photos.findIndex(p => p?.id === this.selectedId) : -1;
        if (key === 'ArrowRight')
            index++;
        else if (key === 'ArrowLeft')
            index--;
        else if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (this.isLoupeMode) {
                if (key === 'ArrowDown')
                    index++;
                else
                    index--;
            }
            else {
                if (key === 'ArrowDown')
                    index += this.cols;
                else
                    index -= this.cols;
            }
        }
        if (index >= 0 && index < photos.length) {
            const target = photos[index];
            if (target)
                hub.pub('photo.selected', { id: target.id, photo: target });
        }
    }
    setupGlobalKeyboard() {
        document.addEventListener('keydown', (e) => { if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
            return; if (e.key === '?' || (e.key === '/' && e.shiftKey))
            hub.pub('shortcuts.show', {}); });
    }
}
const app = new App();
window.app = app;
hub.pub('ui.layout.changed', {});
hub.pub('connection.changed', { connected: false, connecting: true });
