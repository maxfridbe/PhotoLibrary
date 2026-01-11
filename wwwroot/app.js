import * as Api from './Functions.generated.js';
import { hub } from './PubSub.js';
import { server } from './serverOperations.js';
class App {
    constructor() {
        this.allPhotosFlat = [];
        this.photos = []; // Processed list
        this.photoMap = new Map();
        this.roots = [];
        this.userCollections = [];
        this.stats = { totalCount: 0, pickedCount: 0, ratingCounts: [0, 0, 0, 0, 0] };
        this.totalPhotos = 0;
        this.cardCache = new Map();
        this.imageUrlCache = new Map();
        this.selectedId = null;
        this.selectedRootId = null;
        this.selectedCollectionId = null;
        this.filterType = 'all';
        this.filterRating = 0;
        this.stackingEnabled = false;
        this.sortBy = 'date-desc';
        this.searchResultIds = [];
        this.searchTitle = '';
        this.collectionFiles = [];
        this.rowHeight = 230;
        this.minCardWidth = 210;
        this.cols = 1;
        this.visibleRange = { start: 0, end: 0 };
        this.isLoadingChunk = new Set();
        this.isLoupeMode = false;
        // Connection State
        this.disconnectedAt = null;
        this.isConnected = false;
        this.isConnecting = false;
        this.statusInterval = null;
        // Fullscreen state
        this.isFullscreen = false;
        this.fullscreenOverlay = null;
        this.fullscreenImgPlaceholder = null;
        this.fullscreenImgHighRes = null;
        this.fullscreenSpinner = null;
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
        this.metaTitleEl = null;
        this.metaGroups = new Map();
        this.initLayout();
        this.loadData();
        this.setupGlobalKeyboard();
        this.setupContextMenu();
        this.initPubSub();
        this.startStatusTimer();
    }
    initPubSub() {
        hub.sub('photo.selected', (data) => {
            this.selectedId = data.id;
            this.updateSelectionUI(data.id);
            this.loadMetadata(data.id);
            if (this.isFullscreen) {
                this.updateFullscreenImage(data.id);
            }
            else if (this.isLoupeMode) {
                this.loadMainPreview(data.id);
            }
            else {
                this.scrollToPhoto(data.id);
            }
            if (this.workspaceEl)
                this.workspaceEl.focus();
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
        hub.sub('connection.changed', (data) => {
            this.isConnected = data.connected;
            this.isConnecting = data.connecting;
            if (this.isConnected) {
                this.disconnectedAt = null;
            }
            else if (this.disconnectedAt === null) {
                this.disconnectedAt = Date.now();
            }
            this.updateStatusUI();
        });
        hub.sub('ui.notification', (data) => this.showNotification(data.message, data.type));
    }
    startStatusTimer() {
        this.statusInterval = setInterval(() => {
            if (this.disconnectedAt !== null) {
                this.updateStatusUI();
            }
        }, 1000);
    }
    toggleStacking(enabled) {
        this.stackingEnabled = enabled;
        this.processUIStacks();
    }
    setSort(sort) {
        this.sortBy = sort;
        this.processUIStacks();
    }
    handlePhotoUpdate(photo) {
        this.photoMap.set(photo.id, photo);
        const updateTargets = photo.stackFileIds && photo.stackFileIds.length > 0 ? photo.stackFileIds : [photo.id];
        this.allPhotosFlat.forEach(p => {
            if (p && updateTargets.includes(p.id)) {
                p.isPicked = photo.isPicked;
                p.rating = photo.rating;
            }
        });
        this.processUIStacks();
        const rep = this.photos.find(p => p.id === photo.id || (p.stackFileIds && p.stackFileIds.includes(photo.id)));
        if (rep) {
            this.updatePhotoCardUI(rep);
        }
        if (this.selectedId === photo.id)
            this.loadMetadata(photo.id);
    }
    processUIStacks() {
        let result = [];
        if (!this.stackingEnabled) {
            result = this.allPhotosFlat.map(p => ({
                ...p,
                stackCount: 1,
                stackFileIds: [p.id],
                stackExtensions: p.fileName.split('.').pop()?.toUpperCase()
            }));
        }
        else {
            const groups = new Map();
            this.allPhotosFlat.forEach(p => {
                const extIdx = p.fileName?.lastIndexOf('.') || -1;
                const base = extIdx > 0 ? p.fileName.substring(0, extIdx) : p.fileName;
                const key = `${p.rootPathId}|${base}`;
                if (!groups.has(key))
                    groups.set(key, []);
                groups.get(key).push(p);
            });
            result = Array.from(groups.values()).map(group => {
                group.sort((a, b) => {
                    const getRank = (fn) => {
                        const ext = fn.split('.').pop()?.toUpperCase();
                        if (ext === 'ARW')
                            return 0;
                        if (ext === 'JPG' || ext === 'JPEG')
                            return 1;
                        return 2;
                    };
                    return getRank(a.fileName) - getRank(b.fileName);
                });
                const rep = { ...group[0] };
                rep.stackCount = group.length;
                rep.stackFileIds = group.map(p => p.id);
                rep.isPicked = group.some(p => p.isPicked);
                rep.rating = Math.max(...group.map(p => p.rating));
                const exts = Array.from(new Set(group.map(p => p.fileName.split('.').pop()?.toUpperCase())));
                exts.sort();
                rep.stackExtensions = exts.join(' + ');
                return rep;
            });
        }
        result.sort((a, b) => {
            switch (this.sortBy) {
                case 'date-desc': return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                case 'date-asc': return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
                case 'name-asc': return (a.fileName || '').localeCompare(b.fileName || '');
                case 'name-desc': return (b.fileName || '').localeCompare(a.fileName || '');
                case 'rating-desc': return b.rating - a.rating;
                case 'size-desc': return b.size - a.size;
                default: return 0;
            }
        });
        this.photos = result;
        this.totalPhotos = this.photos.length;
        this.renderGrid();
        if (this.isLoupeMode)
            this.renderFilmstrip();
    }
    clearMetadata() {
        if (this.metadataEl)
            this.metadataEl.innerHTML = '';
        this.metaTitleEl = null;
        this.metaGroups.clear();
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
    updateStatusUI() {
        const el = document.getElementById('connection-status');
        if (!el)
            return;
        if (this.isConnected) {
            el.textContent = 'Connected';
            el.style.color = '#0f0';
            return;
        }
        const secs = this.disconnectedAt ? Math.floor((Date.now() - this.disconnectedAt) / 1000) : 0;
        let time = secs + 's';
        if (secs > 60)
            time = Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
        if (this.isConnecting) {
            el.innerHTML = '';
            const s = document.createElement('span');
            s.className = 'spinner';
            s.style.display = 'inline-block';
            s.style.width = '10px';
            s.style.height = '10px';
            s.style.verticalAlign = 'middle';
            s.style.marginRight = '5px';
            el.appendChild(s);
            el.appendChild(document.createTextNode(`Connecting... (${time} offline)`));
            el.style.color = '#aaa';
        }
        else {
            el.textContent = `Disconnected (${time} ago)`;
            el.style.color = '#f00';
        }
    }
    async refreshStatsOnly() {
        this.stats = await Api.api_stats({});
        this.updateSidebarCountsOnly();
    }
    updateSidebarCountsOnly() {
        if (!this.libraryEl)
            return;
        const allCountEl = this.libraryEl.querySelector('.tree-item[data-type="all"] .count');
        if (allCountEl)
            allCountEl.textContent = this.stats.totalCount.toString();
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
        this.allPhotosFlat = [];
        this.photos = [];
        this.cardCache.clear();
        this.isLoadingChunk.clear();
        const params = {
            limit: 100000, offset: 0,
            rootId: this.selectedRootId || undefined,
            pickedOnly: this.filterType === 'picked',
            rating: this.filterRating,
            specificIds: (this.filterType === 'collection' ? this.collectionFiles : (this.filterType === 'search' ? this.searchResultIds : undefined))
        };
        const [data, stats] = await Promise.all([Api.api_photos(params), Api.api_stats({})]);
        this.allPhotosFlat = data.photos;
        this.photoMap.clear();
        this.allPhotosFlat.forEach(p => this.photoMap.set(p.id, p));
        this.stats = stats;
        this.renderLibrary();
        this.processUIStacks();
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
            const headerRight = document.createElement('div');
            headerRight.style.display = 'flex';
            headerRight.style.alignItems = 'center';
            headerRight.style.gap = '15px';
            const sortLabel = document.createElement('label');
            sortLabel.className = 'control-item';
            sortLabel.textContent = 'Sort: ';
            const sortSelect = document.createElement('select');
            sortSelect.style.background = '#111';
            sortSelect.style.color = '#ccc';
            sortSelect.style.border = '1px solid #444';
            sortSelect.style.fontSize = '0.9em';
            const options = [
                { val: 'date-desc', text: 'Date (Newest)' },
                { val: 'date-asc', text: 'Date (Oldest)' },
                { val: 'name-asc', text: 'Name (A-Z)' },
                { val: 'name-desc', text: 'Name (Z-A)' },
                { val: 'rating-desc', text: 'Rating' },
                { val: 'size-desc', text: 'Size' }
            ];
            options.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.val;
                opt.textContent = o.text;
                if (o.val === self.sortBy)
                    opt.selected = true;
                sortSelect.appendChild(opt);
            });
            sortSelect.onchange = (e) => self.setSort(e.target.value);
            sortLabel.appendChild(sortSelect);
            const stackLabel = document.createElement('label');
            stackLabel.className = 'control-item';
            stackLabel.title = 'Stack JPG/ARW files with same name';
            const stackCheck = document.createElement('input');
            stackCheck.type = 'checkbox';
            stackCheck.checked = self.stackingEnabled;
            stackCheck.onchange = (e) => self.toggleStacking(e.target.checked);
            const stackSpan = document.createElement('span');
            stackSpan.textContent = 'Stacked';
            stackLabel.appendChild(stackCheck);
            stackLabel.appendChild(stackSpan);
            const headerCount = document.createElement('span');
            headerCount.id = 'header-count';
            headerCount.textContent = '0 items';
            headerRight.appendChild(sortLabel);
            headerRight.appendChild(stackLabel);
            headerRight.appendChild(headerCount);
            header.appendChild(headerText);
            header.appendChild(headerRight);
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
    syncCardData(card, photo) {
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
        const nameEl = card.querySelector('.filename');
        if (nameEl) {
            let displayName = photo.fileName || '';
            if (photo.stackExtensions && (this.stackingEnabled || photo.stackCount > 1)) {
                const extIdx = displayName.lastIndexOf('.');
                const base = extIdx > 0 ? displayName.substring(0, extIdx) : displayName;
                displayName = `${base} (${photo.stackExtensions})`;
            }
            nameEl.textContent = displayName;
        }
        if (photo.stackCount > 1 && this.stackingEnabled) {
            card.classList.add('is-stacked');
            let badge = card.querySelector('.stack-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'stack-badge';
                card.appendChild(badge);
            }
            badge.textContent = photo.stackCount.toString();
        }
        else {
            card.classList.remove('is-stacked');
            card.querySelector('.stack-badge')?.remove();
        }
    }
    updatePhotoCardUI(photo) {
        const cached = this.cardCache.get(photo.id);
        if (cached)
            this.syncCardData(cached, photo);
        const inDom = this.workspaceEl?.querySelectorAll(`.card[data-id="${photo.id}"]`);
        inDom?.forEach(card => this.syncCardData(card, photo));
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
    }
    renderVisiblePhotos() {
        if (!this.gridView)
            return;
        const startRow = Math.floor(this.visibleRange.start / this.cols);
        this.gridView.style.transform = `translateY(${startRow * this.rowHeight}px)`;
        const fragment = document.createDocumentFragment();
        for (let i = this.visibleRange.start; i < this.visibleRange.end; i++) {
            const photo = this.photos[i];
            if (photo) {
                let card = this.cardCache.get(photo.id);
                if (!card) {
                    card = this.createCard(photo, 'grid');
                    this.cardCache.set(photo.id, card);
                }
                else {
                    this.syncCardData(card, photo);
                }
                fragment.appendChild(card);
            }
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
                fragment.appendChild(placeholder);
            }
        }
        this.gridView.innerHTML = '';
        this.gridView.appendChild(fragment);
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
    getFilteredPhotos() { return this.photos; }
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
        const info = document.createElement('div');
        info.className = 'info';
        const top = document.createElement('div');
        top.className = 'info-top';
        const name = document.createElement('span');
        name.className = 'filename';
        top.appendChild(name);
        const pick = document.createElement('span');
        pick.className = 'pick-btn' + (p.isPicked ? ' picked' : '');
        pick.textContent = '\u2691';
        pick.onclick = (e) => { e.stopPropagation(); server.togglePick(p); };
        top.appendChild(pick);
        const mid = document.createElement('div');
        mid.className = 'info-mid';
        mid.textContent = new Date(p.createdAt).toISOString().split('T')[0];
        const bottom = document.createElement('div');
        bottom.className = 'info-bottom';
        const stars = document.createElement('span');
        stars.className = 'stars' + (p.rating > 0 ? ' has-rating' : '');
        stars.textContent = '\u2605'.repeat(p.rating) || '\u2606\u2606\u2606\u2606\u2606';
        bottom.appendChild(stars);
        info.appendChild(top);
        info.appendChild(mid);
        info.appendChild(bottom);
        card.appendChild(info);
        if (type === 'grid') {
            card.addEventListener('dblclick', () => hub.pub('view.mode.changed', { mode: 'loupe', id: p.id }));
        }
        card.addEventListener('click', () => hub.pub('photo.selected', { id: p.id, photo: p }));
        this.syncCardData(card, p);
        return card;
    }
    lazyLoadImage(id, img, size) {
        const cacheKey = id + '-' + size;
        if (this.imageUrlCache.has(cacheKey)) {
            img.src = this.imageUrlCache.get(cacheKey);
            img.parentElement?.classList.add('loaded');
            return;
        }
        const target = img.parentElement || img;
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    server.requestImage(id, size).then(blob => {
                        const url = URL.createObjectURL(blob);
                        this.imageUrlCache.set(cacheKey, url);
                        img.onload = () => img.parentElement?.classList.add('loaded');
                        img.src = url;
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
        this.selectedId = id;
        this.updateSelectionUI(id);
        this.loadMetadata(id);
        if (this.isFullscreen)
            this.updateFullscreenImage(id);
        else if (this.isLoupeMode)
            this.loadMainPreview(id);
    }
    scrollToPhoto(id) {
        const index = this.photos.findIndex(p => p?.id === id);
        if (index === -1)
            return;
        const row = Math.floor(index / this.cols);
        const gridContainer = this.gridView?.parentElement;
        if (!gridContainer)
            return;
        const currentScroll = gridContainer.scrollTop;
        const viewHeight = gridContainer.clientHeight;
        const targetTop = row * this.rowHeight;
        if (targetTop < currentScroll || targetTop + this.rowHeight > currentScroll + viewHeight) {
            gridContainer.scrollTo({
                top: targetTop - (viewHeight / 2) + (this.rowHeight / 2),
                behavior: 'smooth'
            });
        }
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
        if (this.selectedId)
            this.scrollToPhoto(this.selectedId);
        this.updateVirtualGrid(true);
    }
    loadMainPreview(id) {
        if (!this.mainPreview)
            return;
        this.mainPreview.style.display = 'none';
        if (this.previewSpinner)
            this.previewSpinner.style.display = 'block';
        const cacheKey = id + '-1024';
        if (this.imageUrlCache.has(cacheKey)) {
            this.mainPreview.src = this.imageUrlCache.get(cacheKey);
            this.mainPreview.style.display = 'block';
            if (this.previewSpinner)
                this.previewSpinner.style.display = 'none';
            return;
        }
        server.requestImage(id, 1024).then(blob => {
            if (this.selectedId === id) {
                const url = URL.createObjectURL(blob);
                this.imageUrlCache.set(cacheKey, url);
                this.mainPreview.src = url;
                this.mainPreview.style.display = 'block';
                if (this.previewSpinner)
                    this.previewSpinner.style.display = 'none';
            }
        });
    }
    updateFullscreenImage(id) {
        if (!this.fullscreenImgPlaceholder || !this.fullscreenImgHighRes || !this.fullscreenSpinner)
            return;
        // Reset states
        this.fullscreenImgHighRes.classList.remove('loaded');
        this.fullscreenSpinner.style.display = 'block';
        const lowResKey = id + '-1024';
        const requestFullRes = () => {
            // 2. Request Full Res (size 0)
            server.requestImage(id, 0).then(blob => {
                if (this.selectedId === id && this.isFullscreen) {
                    const url = URL.createObjectURL(blob);
                    this.fullscreenImgHighRes.src = url;
                    this.fullscreenImgHighRes.onload = () => {
                        if (this.selectedId === id) {
                            this.fullscreenImgHighRes.classList.add('loaded');
                            this.fullscreenSpinner.style.display = 'none';
                        }
                    };
                }
            });
        };
        // 1. Stretched Placeholder (Large Preview 1024)
        if (this.imageUrlCache.has(lowResKey)) {
            this.fullscreenImgPlaceholder.src = this.imageUrlCache.get(lowResKey);
            this.fullscreenImgPlaceholder.style.display = 'block';
            requestFullRes();
        }
        else {
            this.fullscreenImgPlaceholder.style.display = 'none';
            // Explicitly request 1024 first
            server.requestImage(id, 1024).then(blob => {
                const url = URL.createObjectURL(blob);
                this.imageUrlCache.set(lowResKey, url);
                if (this.selectedId === id && this.isFullscreen) {
                    this.fullscreenImgPlaceholder.src = url;
                    this.fullscreenImgPlaceholder.style.display = 'block';
                    requestFullRes();
                }
            });
        }
    }
    toggleFullscreen() {
        if (this.isFullscreen) {
            this.fullscreenOverlay?.remove();
            this.fullscreenOverlay = null;
            this.fullscreenImgPlaceholder = null;
            this.fullscreenImgHighRes = null;
            this.fullscreenSpinner = null;
            this.isFullscreen = false;
            return;
        }
        if (!this.selectedId)
            return;
        this.isFullscreen = true;
        const overlay = document.createElement('div');
        overlay.className = 'fullscreen-overlay';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        overlay.appendChild(spinner);
        this.fullscreenSpinner = spinner;
        // Placeholder Image (Blurred / Stretched)
        const imgP = document.createElement('img');
        imgP.className = 'fullscreen-img placeholder';
        overlay.appendChild(imgP);
        this.fullscreenImgPlaceholder = imgP;
        // High-Res Image (Fades In)
        const imgH = document.createElement('img');
        imgH.className = 'fullscreen-img highres';
        overlay.appendChild(imgH);
        this.fullscreenImgHighRes = imgH;
        document.body.appendChild(overlay);
        this.fullscreenOverlay = overlay;
        const closeBtn = document.createElement('div');
        closeBtn.className = 'fullscreen-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = (e) => { e.stopPropagation(); this.toggleFullscreen(); };
        overlay.appendChild(closeBtn);
        overlay.onclick = () => this.toggleFullscreen();
        this.updateFullscreenImage(this.selectedId);
    }
    async loadMetadata(id) {
        if (!this.metadataEl || !id)
            return;
        const photo = this.photoMap.get(id);
        if (!photo)
            return;
        const priorityTags = ['Exposure Time', 'Shutter Speed Value', 'F-Number', 'Aperture Value', 'Max Aperture Value', 'ISO Speed Rating', 'ISO', 'Focal Length', 'Focal Length 35', 'Lens Model', 'Lens', 'Model', 'Make', 'Exposure Bias Value', 'Exposure Mode', 'Exposure Program', 'Focus Mode', 'Image Stabilisation', 'Metering Mode', 'White Balance', 'Flash', 'Color Temperature', 'Quality', 'Created', 'Size', 'Image Width', 'Image Height', 'Exif Image Width', 'Exif Image Height', 'Software', 'Orientation', 'ID'];
        const groupOrder = ['File Info', 'Exif SubIF', 'Exif IFD0', 'Sony Maker', 'GPS', 'XMP'];
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
            if (!this.metaTitleEl) {
                this.metaTitleEl = document.createElement('h2');
                this.metadataEl.appendChild(this.metaTitleEl);
            }
            const pickText = photo.isPicked ? '\u2691' : '';
            const starsText = photo.rating > 0 ? '\u2605'.repeat(photo.rating) : '';
            this.metaTitleEl.textContent = `${photo.fileName} ${pickText} ${starsText}`;
            const seenGroups = new Set();
            for (const k of sortedGroupKeys) {
                seenGroups.add(k);
                let groupInfo = this.metaGroups.get(k);
                if (!groupInfo) {
                    const container = document.createElement('div');
                    container.className = 'meta-group';
                    const h3 = document.createElement('h3');
                    h3.textContent = k;
                    container.appendChild(h3);
                    this.metadataEl.appendChild(container);
                    groupInfo = { container, rows: new Map() };
                    this.metaGroups.set(k, groupInfo);
                }
                const items = groups[k];
                items.sort((a, b) => { let ia = priorityTags.indexOf(a.tag); let ib = priorityTags.indexOf(b.tag); if (ia === -1)
                    ia = 999; if (ib === -1)
                    ib = 999; if (ia !== ib)
                    return ia - ib; return a.tag.localeCompare(b.tag); });
                const seenRows = new Set();
                for (const m of items) {
                    const tagKey = m.tag;
                    seenRows.add(tagKey);
                    let row = groupInfo.rows.get(tagKey);
                    if (!row) {
                        row = document.createElement('div');
                        row.className = 'meta-row';
                        const keySpan = document.createElement('span');
                        keySpan.className = 'meta-key';
                        keySpan.textContent = m.tag || '';
                        const valSpan = document.createElement('span');
                        valSpan.className = 'meta-val';
                        const search = document.createElement('span');
                        search.className = 'meta-search-btn';
                        search.textContent = '\uD83D\uDD0D';
                        search.title = 'Search';
                        row.appendChild(keySpan);
                        row.appendChild(valSpan);
                        row.appendChild(search);
                        groupInfo.container.appendChild(row);
                        groupInfo.rows.set(tagKey, row);
                    }
                    const valSpan = row.querySelector('.meta-val');
                    valSpan.textContent = m.value || '';
                    const searchBtn = row.querySelector('.meta-search-btn');
                    searchBtn.onclick = () => hub.pub('search.triggered', { tag: m.tag, value: m.value });
                }
                for (const [tag, rowEl] of groupInfo.rows.entries()) {
                    if (!seenRows.has(tag)) {
                        rowEl.remove();
                        groupInfo.rows.delete(tag);
                    }
                }
            }
            for (const [groupName, info] of this.metaGroups.entries()) {
                if (!seenGroups.has(groupName)) {
                    info.container.remove();
                    this.metaGroups.delete(groupName);
                }
            }
        }
        catch (err) {
            console.error(err);
            if (this.metadataEl)
                this.metadataEl.textContent = 'Error loading metadata';
        }
    }
    handleKey(e) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)
            return;
        const key = e.key.toLowerCase();
        if (key === 'escape') {
            if (this.isFullscreen)
                this.toggleFullscreen();
        }
        if (key === 'g') {
            if (this.isFullscreen)
                this.toggleFullscreen();
            hub.pub('view.mode.changed', { mode: 'grid' });
        }
        if (key === 'l' || key === 'enter' || e.key === ' ') {
            e.preventDefault();
            if (this.isFullscreen)
                this.toggleFullscreen();
            hub.pub('view.mode.changed', { mode: 'loupe', id: this.selectedId || undefined });
        }
        if (key === 'f') {
            e.preventDefault();
            this.toggleFullscreen();
        }
        if (key === 'p') {
            if (this.selectedId) {
                const p = this.photos.find(x => x.id === this.selectedId);
                if (p)
                    server.togglePick(p);
            }
        }
        if (key >= '0' && key <= '5') {
            if (this.selectedId) {
                const p = this.photos.find(x => x.id === this.selectedId);
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
        if (this.photos.length === 0)
            return;
        let index = this.selectedId ? this.photos.findIndex(p => p?.id === this.selectedId) : -1;
        if (key === 'ArrowRight')
            index++;
        else if (key === 'ArrowLeft')
            index--;
        else if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (this.isLoupeMode || this.isFullscreen) {
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
        index = Math.max(0, Math.min(this.photos.length - 1, index));
        const target = this.photos[index];
        if (target)
            hub.pub('photo.selected', { id: target.id, photo: target });
    }
    setupGlobalKeyboard() {
        document.addEventListener('keydown', (e) => this.handleKey(e));
    }
}
const app = new App();
window.app = app;
hub.pub('ui.layout.changed', {});
hub.pub('connection.changed', { connected: false, connecting: true });
