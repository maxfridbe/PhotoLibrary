import { hub } from './PubSub.js';
import { server } from './CommunicationManager.js';
export class GridView {
    constructor(imageUrlCache, rotationMap) {
        this.gridViewEl = null;
        this.scrollSentinel = null;
        this.cardCache = new Map();
        this.cols = 5;
        this.gridScale = 1.0;
        this.baseRowHeight = 220;
        this.baseMinCardWidth = 200;
        this.visibleRange = { start: 0, end: 50 };
        this.photos = [];
        this.selectedId = null;
        this.instanceId = Math.floor(Math.random() * 10000);
        console.log(`[Grid] Created instance ${this.instanceId}`);
        this.imageUrlCache = imageUrlCache;
        this.rotationMap = rotationMap;
    }
    get rowHeight() {
        return (this.baseRowHeight + 10) * this.gridScale;
    }
    get minCardWidth() {
        return (this.baseMinCardWidth + 10) * this.gridScale;
    }
    setPhotos(photos) {
        console.log(`[Grid] setPhotos: ${photos.length} photos`);
        this.photos = photos;
        this.cardCache.clear();
        this.update(true);
    }
    setSelected(id) {
        // console.log(`[Grid] setSelected: ${id}`);
        const oldId = this.selectedId;
        this.selectedId = id;
        if (oldId)
            this.updateCardSelection(oldId, false);
        if (id)
            this.updateCardSelection(id, true);
    }
    updateCardSelection(id, isSelected) {
        const card = this.cardCache.get(id);
        if (card)
            card.classList.toggle('selected', isSelected);
        const el = this.gridViewEl?.querySelector(`.card[data-id="${id}"]`);
        if (el)
            el.classList.toggle('selected', isSelected);
    }
    setScale(scale) {
        console.log(`[Grid] setScale: ${scale}`);
        this.gridScale = scale;
        document.documentElement.style.setProperty('--card-min-width', (12.5 * this.gridScale) + 'em');
        document.documentElement.style.setProperty('--card-height', (13.75 * this.gridScale) + 'em');
        this.cardCache.clear();
        this.update(true);
    }
    update(force = false) {
        if (!this.gridViewEl) {
            console.warn(`[Grid ${this.instanceId}] update skipped: gridViewEl is null`);
            return;
        }
        const gridContainer = this.gridViewEl.parentElement;
        if (!gridContainer) {
            console.warn(`[Grid ${this.instanceId}] update skipped: gridContainer is null`);
            return;
        }
        const containerWidth = gridContainer.clientWidth - 20;
        // console.log(`[Grid] containerWidth: ${containerWidth}, minCardWidth: ${this.minCardWidth}`);
        this.cols = Math.max(1, Math.floor(containerWidth / this.minCardWidth));
        document.documentElement.style.setProperty('--grid-cols', this.cols.toString());
        const rowCount = Math.ceil(this.photos.length / this.cols);
        const totalHeight = rowCount * this.rowHeight;
        if (this.scrollSentinel)
            this.scrollSentinel.style.height = totalHeight + 'px';
        const scrollTop = gridContainer.scrollTop;
        const viewHeight = gridContainer.clientHeight;
        const startRow = Math.max(0, Math.floor(scrollTop / this.rowHeight) - 1);
        const endRow = Math.ceil((scrollTop + viewHeight) / this.rowHeight) + 2;
        const startIndex = startRow * this.cols;
        const endIndex = Math.min(this.photos.length, endRow * this.cols);
        // console.log(`[Grid] update: photos=${this.photos.length} cols=${this.cols} range=${startIndex}-${endIndex} force=${force}`);
        if (force || startIndex !== this.visibleRange.start || endIndex !== this.visibleRange.end) {
            this.visibleRange = { start: startIndex, end: endIndex };
            this.render();
        }
    }
    render() {
        if (!this.gridViewEl)
            return;
        console.log(`[Grid] render: ${this.visibleRange.start} to ${this.visibleRange.end}`);
        const startRow = Math.floor(this.visibleRange.start / this.cols);
        this.gridViewEl.style.transform = `translateY(${startRow * this.rowHeight}px)`;
        const fragment = document.createDocumentFragment();
        for (let i = this.visibleRange.start; i < this.visibleRange.end; i++) {
            const photo = this.photos[i];
            if (photo) {
                let card = this.cardCache.get(photo.id);
                if (!card) {
                    // console.log(`[Grid] Creating card for ${photo.id}`);
                    card = this.createCard(photo);
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
        this.gridViewEl.innerHTML = '';
        this.gridViewEl.appendChild(fragment);
    }
    createCard(p, mode = 'grid') {
        const card = document.createElement('div');
        card.className = 'card';
        if (this.selectedId === p.id)
            card.classList.add('selected');
        card.dataset.id = p.id;
        const imgContainer = document.createElement('div');
        imgContainer.className = 'img-container';
        const img = document.createElement('img');
        const rot = this.rotationMap.get(p.id);
        if (rot)
            img.style.transform = `rotate(${rot}deg)`;
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
        if (mode === 'grid') {
            card.addEventListener('dblclick', () => hub.pub('view.mode.changed', { mode: 'loupe', id: p.id }));
        }
        card.addEventListener('click', () => hub.pub('photo.selected', { id: p.id, photo: p }));
        this.syncCardData(card, p);
        return card;
    }
    syncCardData(card, photo) {
        const nameEl = card.querySelector('.filename');
        if (nameEl)
            nameEl.textContent = photo.fileName || '';
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
        }
        else if (badge) {
            badge.remove();
        }
        const img = card.querySelector('img');
        if (img) {
            const rot = this.rotationMap.get(photo.id) || 0;
            img.style.transform = `rotate(${rot}deg)`;
        }
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
                    server.requestImage(id, size).then((blob) => {
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
    scrollToPhoto(id) {
        const index = this.photos.findIndex(p => p?.id === id);
        if (index === -1)
            return;
        const row = Math.floor(index / this.cols);
        const gridContainer = this.gridViewEl?.parentElement;
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
    refreshStats(id, photos) {
        const photo = photos.find(p => p.id === id);
        if (!photo)
            return;
        const cached = this.cardCache.get(id);
        if (cached)
            this.syncCardData(cached, photo);
        const inDom = this.gridViewEl?.querySelectorAll(`.card[data-id="${id}"]`);
        inDom?.forEach(card => this.syncCardData(card, photo));
    }
    clearCache() {
        this.cardCache.clear();
    }
    getColumnCount() {
        return this.cols;
    }
}
