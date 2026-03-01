/** @jsx jsx */
import { jsx, patch, VNode } from './snabbdom-setup.js';
import * as Res from './Responses.generated.js';
import { hub } from './PubSub.js';
import { server } from './CommunicationManager.js';
import { constants } from './constants.js';
import { PhotoCard } from './components/grid/PhotoCard.js';

const ps = constants.pubsub;

type Photo = Res.PhotoResponse;

export class GridView {
    private $_gridViewEl: HTMLElement | null = null;
    public set $gridViewEl(el: HTMLElement | null) {
        this.$_gridViewEl = el;
        this.gridVNode = null;
    }
    public get $gridViewEl() { return this.$_gridViewEl; }

    public $scrollSentinel: HTMLElement | null = null;

    private $_filmstripEl: HTMLElement | null = null;
    public set $filmstripEl(el: HTMLElement | null) {
        this.$_filmstripEl = el;
        this.filmstripVNode = null;
        if (el) {
            el.onscroll = () => this.renderFilmstrip();
            setTimeout(() => this.renderFilmstrip(), 0);
        }
    }
    public get $filmstripEl() { return this.$_filmstripEl; }
    
    private gridVNode: VNode | HTMLElement | null = null;
    private filmstripVNode: VNode | HTMLElement | null = null;

    private imageUrlCache: Map<string, string>;
    private rotationMap: Map<string, number>;
    
    private cols = 5;
    private gridScale = 1.0;
    private readonly baseRowHeight = 220; 
    private readonly baseMinCardWidth = 200; 
    
    private visibleRange = { start: 0, end: 50 };
    private photos: Photo[] = [];
    private selectedId: string | null = null;
    private selectedIds: Set<string> = new Set();
    private generatingIds = new Set<string>();
    private priorityProvider: (id: string) => number;
    private isScrolling = false;
    private scrollingTimer: any = null;

    constructor(imageUrlCache: Map<string, string>, rotationMap: Map<string, number>, priorityProvider: (id: string) => number) {
        this.imageUrlCache = imageUrlCache;
        this.rotationMap = rotationMap;
        this.priorityProvider = priorityProvider;

        hub.sub(ps.PREVIEW_GENERATING, (data) => {
            this.generatingIds.add(data.fileEntryId);
            this.update(true);
        });

        hub.sub(ps.PREVIEW_GENERATED, (data) => {
            this.generatingIds.delete(data.fileEntryId);
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
        if (!this.$filmstripEl) return 210;
        const fsHeight = this.$filmstripEl.clientHeight;
        if (fsHeight === 0) return 210;
        // The filmstrip cards are square-ish based on height
        return (fsHeight * 1.0); 
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

    public setSelected(id: string | null, ids?: Set<string>) {
        this.selectedId = id;
        if (ids) this.selectedIds = ids;
        else {
            this.selectedIds.clear();
            if (id) this.selectedIds.add(id);
        }
        this.update(true);
    }

    public setScale(scale: number) {
        this.gridScale = scale;
        document.documentElement.style.setProperty('--card-min-width', (12.5 * this.gridScale) + 'em');
        document.documentElement.style.setProperty('--card-height', (13.75 * this.gridScale) + 'em');
        this.update(true);
    }

    private updateTimer: any = null;
    public updateDebounced(force: boolean = false) {
        if (this.updateTimer) clearTimeout(this.updateTimer);
        this.updateTimer = setTimeout(() => {
            this.update(force);
            this.updateTimer = null;
        }, 50);
    }

    public update(force: boolean = false, isFromScroll: boolean = false) {
        if (!this.$gridViewEl) return;
        const gridContainer = this.$gridViewEl.parentElement as HTMLElement;
        if (!gridContainer) return;

        if (isFromScroll) {
            this.isScrolling = true;
            if (this.scrollingTimer) clearTimeout(this.scrollingTimer);
            this.scrollingTimer = setTimeout(() => {
                this.isScrolling = false;
                this.update(true); // Force re-render to trigger lazy loading
                this.scrollingTimer = null;
            }, 150); // Slightly longer debounce for smoother experience
        }

        const containerWidth = gridContainer.clientWidth - 20;
        this.cols = Math.max(1, Math.floor(containerWidth / this.minCardWidth));
        document.documentElement.style.setProperty('--grid-cols', this.cols.toString());
        
        const rowCount = Math.ceil(this.photos.length / this.cols);
        const totalHeight = rowCount * this.rowHeight;
        if (this.$scrollSentinel) this.$scrollSentinel.style.height = totalHeight + 'px';

        const scrollTop = gridContainer.scrollTop;
        const viewHeight = gridContainer.clientHeight;
        const startRow = Math.max(0, Math.floor(scrollTop / this.rowHeight) - 1);
        const endRow = Math.ceil((scrollTop + viewHeight) / this.rowHeight) + 2;
        
        const startIndex = startRow * this.cols;
        const endIndex = Math.min(this.photos.length, endRow * this.cols);
        
        if (force || startIndex !== this.visibleRange.start || endIndex !== this.visibleRange.end || (this.isScrolling && !force)) {
            this.visibleRange = { start: startIndex, end: endIndex };
            this.render();
        }

        if (this.$filmstripEl && (window as any).app.isLoupeMode) {
            this.renderFilmstrip();
        }
    }

    private render() {
        if (!this.$gridViewEl) return;
        const startRow = Math.floor(this.visibleRange.start / this.cols);
        const translateY = startRow * this.rowHeight;

        const cards: VNode[] = [];
        for (let i = this.visibleRange.start; i < this.visibleRange.end; i++) {
            const photo = this.photos[i];
            if (photo) {
                cards.push(
                    <PhotoCard
                        photo={photo}
                        isSelected={this.selectedIds.has(photo.fileEntryId) || (!!photo.stackFileIds && photo.stackFileIds.some(sid => this.selectedIds.has(sid)))}
                        isGenerating={this.generatingIds.has(photo.fileEntryId)}
                        isScrolling={this.isScrolling}
                        rotation={this.rotationMap.get(photo.fileEntryId) || 0}
                        mode="grid"
                        imageUrlCache={this.imageUrlCache}
                        onSelect={(id, p, mods) => hub.pub(ps.PHOTO_SELECTED, { fileEntryId: id, photo: p, modifiers: mods })}
                        onDoubleClick={(id) => hub.pub(ps.VIEW_MODE_CHANGED, { mode: 'loupe', fileEntryId: id })}
                        onContextMenu={(e, p) => (window as any).app.showPhotoContextMenu(e, p)}
                        onTogglePick={(p) => server.togglePick(p)}
                        onRate={(p, r) => server.setRating(p, r)}
                        onRotate={(p, r) => hub.pub(ps.PHOTO_ROTATED, { fileEntryId: p.fileEntryId, rotation: r })}
                    />
                );
            }
        }

        const newVNode = (
            <div 
                id="grid-view" 
                class={{ 'grid-view': true }}
                style={{ 
                    transform: `translateY(${translateY}px)`,
                    position: 'absolute', top: '0', left: '0', right: '0'
                }}
            >
                {cards}
            </div>
        );

        if (!this.gridVNode) this.gridVNode = this.$gridViewEl;
        this.gridVNode = patch(this.gridVNode, newVNode);
        this.$_gridViewEl = (this.gridVNode as VNode).elm as HTMLElement;
    }

    private renderFilmstrip() {
        if (!this.$filmstripEl) return;

        const container = this.$filmstripEl;
        const scrollLeft = container.scrollLeft;
        const viewWidth = container.clientWidth;
        const cardWidth = this.filmstripCardWidth;
        const gap = 0.65 * 16; // 0.65em in pixels (approx)

        const startIndex = Math.max(0, Math.floor(scrollLeft / (cardWidth + gap)) - 2);
        const endIndex = Math.min(this.photos.length, Math.ceil((scrollLeft + viewWidth) / (cardWidth + gap)) + 2);

        const cards: VNode[] = [];
        for (let i = startIndex; i < endIndex; i++) {
            const photo = this.photos[i];
            if (photo) {
                cards.push(
                    <PhotoCard
                        photo={photo}
                        isSelected={this.selectedIds.has(photo.fileEntryId) || (!!photo.stackFileIds && photo.stackFileIds.some(sid => this.selectedIds.has(sid)))}
                        isGenerating={this.generatingIds.has(photo.fileEntryId)}
                        isScrolling={this.isScrolling}
                        rotation={this.rotationMap.get(photo.fileEntryId) || 0}
                        mode="filmstrip"
                        imageUrlCache={this.imageUrlCache}
                        onSelect={(id, p, mods) => hub.pub(ps.PHOTO_SELECTED, { fileEntryId: id, photo: p, modifiers: mods })}
                        onDoubleClick={() => {}}
                        onContextMenu={(e, p) => (window as any).app.showPhotoContextMenu(e, p)}
                        onTogglePick={(p) => server.togglePick(p)}
                        onRate={(p, r) => server.setRating(p, r)}
                        onRotate={(p, r) => hub.pub(ps.PHOTO_ROTATED, { fileEntryId: p.fileEntryId, rotation: r })}
                    />
                );
            }
        }

        const totalWidth = this.photos.length * (cardWidth + gap);
        const newVNode = (
            <div 
                id="filmstrip-content"
                style={{ 
                    display: 'flex',
                    height: '100%',
                    gap: '0.65em',
                    padding: '0 0.65em',
                    alignItems: 'center',
                    width: `${totalWidth}px`,
                    position: 'relative'
                }}
            >
                <div style={{ 
                    display: 'flex', 
                    gap: '0.65em', 
                    position: 'absolute', 
                    left: `${startIndex * (cardWidth + gap)}px`,
                    height: '100%',
                    alignItems: 'center'
                }}>
                    {cards}
                </div>
            </div>
        );

        if (!this.filmstripVNode) {
            this.$filmstripEl.innerHTML = '';
            const wrap = document.createElement('div');
            this.$filmstripEl.appendChild(wrap);
            this.filmstripVNode = wrap;
        }
        this.filmstripVNode = patch(this.filmstripVNode, newVNode);
        this.$_filmstripEl = (this.filmstripVNode as VNode).elm as HTMLElement;
    }

    public lazyLoadImage(id: string, img: HTMLImageElement, size: number) {
        const cacheKey = id + '-' + size;
        if (this.imageUrlCache.has(cacheKey)) {
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
            const url = URL.createObjectURL(blob);
            this.imageUrlCache.set(cacheKey, url);
            img.onload = () => {
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
        console.log(`[Grid] scrollToPhoto called for ${id}. Photos count: ${this.photos.length}`);
        const index = this.photos.findIndex(p => p?.fileEntryId === id || (p?.stackFileIds && p.stackFileIds.indexOf(id) !== -1));
        console.log(`[Grid] findIndex result: ${index}`);
        if (index === -1) {
            console.warn(`[Grid] Photo ${id} not found in current photo list.`);
            return;
        }

        if (this.$gridViewEl) {
            const row = Math.floor(index / this.cols);
            const gridContainer = this.$gridViewEl.parentElement as HTMLElement;
            if (gridContainer) {
                const currentScroll = gridContainer.scrollTop;
                const viewHeight = gridContainer.clientHeight;
                const targetTop = row * this.rowHeight;
                console.log(`[Grid] Scrolling: row=${row}, cols=${this.cols}, targetTop=${targetTop}, currentScroll=${currentScroll}, viewHeight=${viewHeight}`);
                
                if (targetTop < currentScroll || targetTop + this.rowHeight > currentScroll + viewHeight) {
                    console.log(`[Grid] Executing scrollTo top=${targetTop - (viewHeight / 2) + (this.rowHeight / 2)}`);
                    gridContainer.scrollTo({
                        top: targetTop - (viewHeight / 2) + (this.rowHeight / 2),
                        behavior: 'smooth'
                    });
                } else {
                    console.log(`[Grid] Already in view.`);
                }
            } else {
                console.error(`[Grid] No parent container found for gridViewEl.`);
            }
        } else {
            console.warn(`[Grid] gridViewEl not set.`);
        }

        if (this.$filmstripEl) {
            const el = this.$filmstripEl.querySelector(`.card[data-id="${id}"]`);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
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
