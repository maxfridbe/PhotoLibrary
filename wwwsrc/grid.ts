import * as Res from './Responses.generated.js';
import { hub } from './PubSub.js';
import { server } from './CommunicationManager.js';
import { constants } from './constants.js';
import { patch, h, VNode } from './snabbdom-setup.js';
import { PhotoCard } from './components/grid/PhotoCard.js';

const ps = constants.pubsub;

type Photo = Res.PhotoResponse;

export class GridView {
    private _gridViewEl: HTMLElement | null = null;
    public set gridViewEl(el: HTMLElement | null) {
        this._gridViewEl = el;
        this.gridVNode = null;
    }
    public get gridViewEl() { return this._gridViewEl; }

    public scrollSentinel: HTMLElement | null = null;

    private _filmstripEl: HTMLElement | null = null;
    public set filmstripEl(el: HTMLElement | null) {
        this._filmstripEl = el;
        this.filmstripVNode = null;
    }
    public get filmstripEl() { return this._filmstripEl; }
    
    private gridVNode: VNode | HTMLElement | null = null;
    private filmstripVNode: VNode | HTMLElement | null = null;

    private imageUrlCache: Map<string, string>;
    private rotationMap: Map<string, number>;
    
    private cols = 5;
    private gridScale = 1.0;
    private readonly baseRowHeight = 220; 
    private readonly baseMinCardWidth = 200; 
    
    private visibleRange = { start: 0, end: 50 };
    private filmstripVisibleRange = { start: 0, end: 20 };
    private photos: Photo[] = [];
    private selectedId: string | null = null;
    private generatingIds = new Set<string>();
    private priorityProvider: (id: string) => number;

    constructor(imageUrlCache: Map<string, string>, rotationMap: Map<string, number>, priorityProvider: (id: string) => number) {
        this.imageUrlCache = imageUrlCache;
        this.rotationMap = rotationMap;
        this.priorityProvider = priorityProvider;

        hub.sub(ps.PREVIEW_GENERATING, (data) => {
            this.generatingIds.add(data.fileId);
            this.update(true);
        });

        hub.sub(ps.PREVIEW_GENERATED, (data) => {
            this.generatingIds.delete(data.fileId);
            this.update(true);
        });

        hub.sub(ps.PHOTO_UPDATED, () => this.update(true));
        hub.sub(ps.PHOTO_PICKED_ADDED, () => this.update(true));
        hub.sub(ps.PHOTO_PICKED_REMOVED, () => this.update(true));
        hub.sub(ps.PHOTO_STARRED_ADDED, () => this.update(true));
        hub.sub(ps.PHOTO_STARRED_REMOVED, () => this.update(true));
        hub.sub(ps.PHOTO_STARRED_CHANGED, () => this.update(true));
    }

    private get rowHeight() { 
        return (this.baseRowHeight + 10) * this.gridScale; 
    }
    private get minCardWidth() { 
        return (this.baseMinCardWidth + 10) * this.gridScale; 
    }

    private get filmstripCardWidth() {
        if (!this.filmstripEl) return 210;
        // height is 12.5em, card is 10.5em h, 12.5em w.
        // Approx 200px wide + 10px gap.
        const fsHeight = this.filmstripEl.clientHeight;
        if (fsHeight === 0) return 210;
        return (fsHeight * 1.0) + 10; // width is same as container height approx
    }

    public setPhotos(photos: Photo[]) {
        this.photos = photos;
        this.update(true);
    }

    public clearCache() {
        this.imageUrlCache.forEach(url => URL.revokeObjectURL(url));
        this.imageUrlCache.clear();
        this.update(true);
    }

    public setSelected(id: string | null) {
        this.selectedId = id;
        this.update(true);
    }

    public setScale(scale: number) {
        this.gridScale = scale;
        document.documentElement.style.setProperty('--card-min-width', (12.5 * this.gridScale) + 'em');
        document.documentElement.style.setProperty('--card-height', (13.75 * this.gridScale) + 'em');
        this.update(true);
    }

    // REQ-WFE-00001
    public update(force: boolean = false) {
        if (!this.gridViewEl) return;
        const gridContainer = this.gridViewEl.parentElement as HTMLElement;
        if (!gridContainer) return;

        const containerWidth = gridContainer.clientWidth - 20;
        this.cols = Math.max(1, Math.floor(containerWidth / this.minCardWidth));
        document.documentElement.style.setProperty('--grid-cols', this.cols.toString());
        
        const rowCount = Math.ceil(this.photos.length / this.cols);
        const totalHeight = rowCount * this.rowHeight;
        if (this.scrollSentinel) this.scrollSentinel.style.height = totalHeight + 'px';

        const scrollTop = gridContainer.scrollTop;
        const viewHeight = gridContainer.clientHeight;
        const startRow = Math.max(0, Math.floor(scrollTop / this.rowHeight) - 1);
        const endRow = Math.ceil((scrollTop + viewHeight) / this.rowHeight) + 2;
        
        const startIndex = startRow * this.cols;
        const endIndex = Math.min(this.photos.length, endRow * this.cols);
        
        if (force || startIndex !== this.visibleRange.start || endIndex !== this.visibleRange.end) {
            this.visibleRange = { start: startIndex, end: endIndex };
            this.render();
        }

        if (this.filmstripEl && window.app.isLoupeMode) {
            this.renderFilmstrip();
        }
    }

    private render() {
        if (!this.gridViewEl) return;
        const startRow = Math.floor(this.visibleRange.start / this.cols);
        const translateY = startRow * this.rowHeight;

        const cards: VNode[] = [];
        for (let i = this.visibleRange.start; i < this.visibleRange.end; i++) {
            const photo = this.photos[i];
            if (photo) {
                cards.push(PhotoCard({
                    photo,
                    isSelected: this.selectedId === photo.id,
                    isGenerating: this.generatingIds.has(photo.id),
                    rotation: this.rotationMap.get(photo.id) || 0,
                    mode: 'grid',
                    imageUrlCache: this.imageUrlCache,
                    onSelect: (id, p) => hub.pub(ps.PHOTO_SELECTED, { id, photo: p }),
                    onDoubleClick: (id) => hub.pub(ps.VIEW_MODE_CHANGED, { mode: 'loupe', id }),
                    onContextMenu: (e, p) => window.app.showPhotoContextMenu(e, p),
                    onTogglePick: (p) => server.togglePick(p)
                }));
            }
        }

        const newVNode = h('div#grid-view.grid-view', {
            style: { 
                transform: `translateY(${translateY}px)`,
                position: 'absolute', top: '0', left: '0', right: '0'
            }
        }, cards);

        if (!this.gridVNode) this.gridVNode = this.gridViewEl;
        this.gridVNode = patch(this.gridVNode, newVNode);
        this._gridViewEl = (this.gridVNode as VNode).elm as HTMLElement;
    }

    private renderFilmstrip() {
        if (!this.filmstripEl) return;

        const cards = this.photos.map(photo => PhotoCard({
            photo,
            isSelected: this.selectedId === photo.id,
            isGenerating: this.generatingIds.has(photo.id),
            rotation: this.rotationMap.get(photo.id) || 0,
            mode: 'filmstrip',
            imageUrlCache: this.imageUrlCache,
            onSelect: (id, p) => hub.pub(ps.PHOTO_SELECTED, { id, photo: p }),
            onDoubleClick: () => {},
            onContextMenu: (e, p) => window.app.showPhotoContextMenu(e, p),
            onTogglePick: (p) => server.togglePick(p)
        }));

        const newVNode = h('div#filmstrip-content', {
            style: { 
                display: 'flex',
                height: '100%',
                gap: '0.65em',
                padding: '0 0.65em',
                alignItems: 'center'
            }
        }, cards);

        if (!this.filmstripVNode) {
            this.filmstripEl.innerHTML = '';
            const container = document.createElement('div');
            this.filmstripEl.appendChild(container);
            this.filmstripVNode = container;
        }
        this.filmstripVNode = patch(this.filmstripVNode, newVNode);
        this._filmstripEl = (this.filmstripVNode as VNode).elm as HTMLElement;
    }

    public lazyLoadImage(id: string, img: HTMLImageElement, size: number) {
        const cacheKey = id + '-' + size;
        if (this.imageUrlCache.has(cacheKey)) {
            // console.log(`[Grid] Cache hit for ${id}`);
            img.src = this.imageUrlCache.get(cacheKey)!;
            img.parentElement?.classList.add('loaded');
            const card = img.closest('.card');
            if (card) {
                card.classList.remove('loading');
                if (!this.generatingIds.has(id)) card.classList.remove('generating');
            }
            return;
        }

        const priority = this.priorityProvider(id);
        server.requestImage(id, size, priority).then((blob: Blob) => {
            // console.log(`[Grid] Received blob for ${id}, size: ${blob.size}`);
            const url = URL.createObjectURL(blob);
            this.imageUrlCache.set(cacheKey, url);
            img.onload = () => {
                // console.log(`[Grid] Image loaded ${id}`);
                img.parentElement?.classList.add('loaded');
                const card = img.closest('.card');
                if (card) {
                    card.classList.remove('loading');
                    card.classList.remove('generating');
                }
            };
            img.onerror = () => {
                console.error(`[Grid] Image load error ${id}`);
                img.closest('.card')?.classList.remove('loading'); 
            };
            img.src = url;
        }).catch(e => {
            console.error(`[Grid] Request failed for ${id}`, e);
            img.closest('.card')?.classList.remove('loading');
        });
    }

    public scrollToPhoto(id: string) {
        const index = this.photos.findIndex(p => p?.id === id);
        if (index === -1) return;

        // Grid Scroll
        if (this.gridViewEl) {
            const row = Math.floor(index / this.cols);
            const gridContainer = this.gridViewEl.parentElement as HTMLElement;
            if (gridContainer) {
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
        }

        // Filmstrip Scroll
        if (this.filmstripEl) {
            const cardWidth = this.filmstripCardWidth;
            const targetLeft = index * cardWidth;
            const currentScroll = this.filmstripEl.scrollLeft;
            const viewWidth = this.filmstripEl.clientWidth;

            if (targetLeft < currentScroll || targetLeft + cardWidth > currentScroll + viewWidth) {
                this.filmstripEl.scrollTo({
                    left: targetLeft - (viewWidth / 2) + (cardWidth / 2),
                    behavior: 'smooth'
                });
            }
        }
    }


    public refreshStats(id: string, photos: Photo[]) {
        this.photos = photos;
        this.update(true);
    }

    public getColumnCount() {
        return this.cols;
    }
}
