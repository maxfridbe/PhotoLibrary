import * as Res from './Responses.generated.js';
import { hub } from './PubSub.js';
import { server } from './CommunicationManager.js';

type Photo = Res.PhotoResponse;

export class GridView {
    public gridViewEl: HTMLElement | null = null;
    public scrollSentinel: HTMLElement | null = null;
    
    private cardCache: Map<string, HTMLElement> = new Map();
    private imageUrlCache: Map<string, string>;
    private rotationMap: Map<string, number>;
    
    private cols = 5;
    private gridScale = 1.0;
    private readonly baseRowHeight = 220; 
    private readonly baseMinCardWidth = 200; 
    
    private visibleRange = { start: 0, end: 50 };
    private photos: Photo[] = [];
    private selectedId: string | null = null;
    private generatingIds = new Set<string>();

    constructor(imageUrlCache: Map<string, string>, rotationMap: Map<string, number>) {
        this.imageUrlCache = imageUrlCache;
        this.rotationMap = rotationMap;

        hub.sub('preview.generating', (data) => {
            this.generatingIds.add(data.fileId);
            this.updateCardSpinner(data.fileId, true);
        });

        hub.sub('preview.generated', (data) => {
            this.generatingIds.delete(data.fileId);
            this.updateCardSpinner(data.fileId, false);
            // Also force image reload if visible?
            // lazyLoadImage will handle cache check, but we might need to force re-check
            // Actually, lazyLoadImage sets cache. 
            // If we are showing spinner, image is not loaded.
            // We should re-trigger load or just let lazyLoad handle it?
            // If the card is visible, lazyLoadImage's observer has already fired request.
            // We need to update the img src if it was empty/placeholder.
            // But requestImage awaits... so it should resolve now?
            // No, requestImage resolves when server responds.
            // So we don't need to do anything else here except hide spinner.
        });
    }

    private updateCardSpinner(id: string, show: boolean) {
        const card = this.cardCache.get(id);
        if (card) {
            if (show) card.classList.add('generating');
            else card.classList.remove('generating');
        }
        const el = this.gridViewEl?.querySelector(`.card[data-id="${id}"]`);
        if (el) {
            if (show) el.classList.add('generating');
            else el.classList.remove('generating');
        }
    }

    private get rowHeight() { 
        return (this.baseRowHeight + 10) * this.gridScale; 
    }
    private get minCardWidth() { 
        return (this.baseMinCardWidth + 10) * this.gridScale; 
    }

    public setPhotos(photos: Photo[]) {
        this.photos = photos;
        this.cardCache.clear();
        this.update(true);
    }

    public setSelected(id: string | null) {
        const oldId = this.selectedId;
        this.selectedId = id;
        if (oldId) this.updateCardSelection(oldId, false);
        if (id) this.updateCardSelection(id, true);
    }

    private updateCardSelection(id: string, isSelected: boolean) {
        const card = this.cardCache.get(id);
        if (card) card.classList.toggle('selected', isSelected);
        const el = this.gridViewEl?.querySelector(`.card[data-id="${id}"]`);
        if (el) el.classList.toggle('selected', isSelected);
    }

    public setScale(scale: number) {
        this.gridScale = scale;
        document.documentElement.style.setProperty('--card-min-width', (12.5 * this.gridScale) + 'em');
        document.documentElement.style.setProperty('--card-height', (13.75 * this.gridScale) + 'em');
        this.cardCache.clear();
        this.update(true);
    }

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
    }

    private render() {
        if (!this.gridViewEl) return;
        const startRow = Math.floor(this.visibleRange.start / this.cols);
        this.gridViewEl.style.transform = `translateY(${startRow * this.rowHeight}px)`;

        const fragment = document.createDocumentFragment();
        let hits = 0, misses = 0;
        for (let i = this.visibleRange.start; i < this.visibleRange.end; i++) {
            const photo = this.photos[i];
            if (photo) {
                let card = this.cardCache.get(photo.id);
                if (!card) {
                    misses++;
                    card = this.createCard(photo);
                    this.cardCache.set(photo.id, card);
                } else {
                    hits++;
                    this.syncCardData(card, photo);
                }
                fragment.appendChild(card);
            } else {
                // placeholder
            }
        }
        console.log(`[Grid] Render: ${hits} hits, ${misses} misses`);
        this.gridViewEl.innerHTML = '';
        this.gridViewEl.appendChild(fragment);
    }

    public createCard(p: Photo, mode: 'grid' | 'filmstrip' = 'grid'): HTMLElement {
        const card = document.createElement('div');
        card.className = 'card loading'; // Start with loading
        if (this.selectedId === p.id) card.classList.add('selected');
        card.dataset.id = p.id;
        
        const imgContainer = document.createElement('div');
        imgContainer.className = 'img-container';
        const img = document.createElement('img');
        
        const spinner = document.createElement('div');
        spinner.className = 'card-spinner';
        imgContainer.appendChild(spinner);

        const rot = this.rotationMap.get(p.id);
        if (rot) img.style.transform = `rotate(${rot}deg)`;
        
        imgContainer.appendChild(img);
        this.lazyLoadImage(p.id, img, 300);
        card.appendChild(imgContainer);
        
        const info = document.createElement('div');
        info.className = 'info';
        
        const top = document.createElement('div');
        top.className = 'info-top';
        const name = document.createElement('span'); name.className = 'filename'; 
        top.appendChild(name);
        
        const pick = document.createElement('span'); pick.className = 'pick-btn' + (p.isPicked ? ' picked' : ''); pick.textContent = '\u2691';
        pick.onclick = (e) => { e.stopPropagation(); server.togglePick(p); };
        top.appendChild(pick);
        
        const mid = document.createElement('div');
        mid.className = 'info-mid';
        mid.textContent = new Date(p.createdAt).toISOString().split('T')[0];
        
        const bottom = document.createElement('div');
        bottom.className = 'info-bottom';
        const stars = document.createElement('span'); stars.className = 'stars' + (p.rating > 0 ? ' has-rating' : '');
        stars.textContent = '\u2605'.repeat(p.rating) || '\u2606\u2606\u2606\u2606\u2606';
        bottom.appendChild(stars);
        
        info.appendChild(top); 
        info.appendChild(mid);
        info.appendChild(bottom);
        card.appendChild(info);
        
        if (mode === 'grid') {
            card.addEventListener('dblclick', () => hub.pub('view.mode.changed', { mode: 'loupe', id: p.id }));
        }
        card.addEventListener('click', () => hub.pub('photo.selected', { id: p.id, photo: p }));
        
        this.syncCardData(card, p); 
        return card;
    }

    public syncCardData(card: HTMLElement, photo: Photo) {
        const nameEl = card.querySelector('.filename');
        if (nameEl) nameEl.textContent = photo.fileName || '';

        const pickEl = card.querySelector('.pick-btn');
        if (pickEl) {
            pickEl.className = 'pick-btn' + (photo.isPicked ? ' picked' : '');
        }

        const starsEl = card.querySelector('.stars');
        if (starsEl) {
            starsEl.className = 'stars' + (photo.rating > 0 ? ' has-rating' : '');
            starsEl.textContent = '\u2605'.repeat(photo.rating) || '\u2606\u2606\u2606\u2606\u2606';
        }

        const stackCount = photo.stackCount || 1;
        card.classList.toggle('is-stacked', stackCount > 1);
        let badge = card.querySelector('.stack-badge');
        if (stackCount > 1) {
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'stack-badge';
                card.appendChild(badge);
            }
            badge.textContent = stackCount.toString();
        } else if (badge) {
            badge.remove();
        }

        const img = card.querySelector('img');
        if (img) {
            const rot = this.rotationMap.get(photo.id) || 0;
            img.style.transform = `rotate(${rot}deg)`;
        }

        if (this.generatingIds.has(photo.id)) card.classList.add('generating');
        else card.classList.remove('generating');
    }

    private lazyLoadImage(id: string, img: HTMLImageElement, size: number) {
        const cacheKey = id + '-' + size;
        if (this.imageUrlCache.has(cacheKey)) {
            // console.log(`[Grid] Cache hit for ${id}`);
            img.src = this.imageUrlCache.get(cacheKey)!;
            img.parentElement?.classList.add('loaded');
            img.closest('.card')?.classList.remove('loading');
            return;
        }

        const target = img.parentElement || img;
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    // console.log(`[Grid] Requesting ${id}`);
                    server.requestImage(id, size).then((blob: Blob) => {
                        // console.log(`[Grid] Received blob for ${id}, size: ${blob.size}`);
                        const url = URL.createObjectURL(blob);
                        this.imageUrlCache.set(cacheKey, url);
                        img.onload = () => {
                            // console.log(`[Grid] Image loaded ${id}`);
                            img.parentElement?.classList.add('loaded');
                            img.closest('.card')?.classList.remove('loading');
                        };
                        img.onerror = () => {
                            console.error(`[Grid] Image load error ${id}`);
                            img.closest('.card')?.classList.remove('loading'); // Stop spinner on error
                        };
                        img.src = url;
                    }).catch(e => {
                        console.error(`[Grid] Request failed for ${id}`, e);
                        img.closest('.card')?.classList.remove('loading');
                    });
                    observer.disconnect();
                }
            });
        });
        observer.observe(target);
    }

    public scrollToPhoto(id: string) {
        const index = this.photos.findIndex(p => p?.id === id);
        if (index === -1) return;
        const row = Math.floor(index / this.cols);
        const gridContainer = this.gridViewEl?.parentElement as HTMLElement;
        if (!gridContainer) return;

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

    public refreshStats(id: string, photos: Photo[]) {
        const photo = photos.find(p => p.id === id);
        if (!photo) return;
        const cached = this.cardCache.get(id);
        if (cached) this.syncCardData(cached, photo);
        const inDom = this.gridViewEl?.querySelectorAll(`.card[data-id="${id}"]`);
        inDom?.forEach(card => this.syncCardData(card as HTMLElement, photo));
    }

    public clearCache() {
        this.cardCache.clear();
    }

    public getColumnCount() {
        return this.cols;
    }
}
