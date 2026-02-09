/** @jsx jsx */
import { jsx, patch, VNode } from './snabbdom-setup.js';
import * as Res from './Responses.generated.js';
import { hub } from './PubSub.js';
import { server } from './CommunicationManager.js';
import { constants } from './constants.js';
import { PhotoCard } from './components/grid/PhotoCard.js';

const ps = constants.pubsub;

type Photo = Res.PhotoResponse;

interface TimelineGroup {
    title: string;
    photos: Photo[];
    startIndex: number;
}

export class TimelineView {
    private $_viewEl: HTMLElement | null = null;
    public set $viewEl(el: HTMLElement | null) {
        this.$_viewEl = el;
        this.vnode = null;
    }
    public get $viewEl() { return this.$_viewEl; }

    public $scrollSentinel: HTMLElement | null = null;
    private vnode: VNode | HTMLElement | null = null;

    private imageUrlCache: Map<string, string>;
    private rotationMap: Map<string, number>;
    private priorityProvider: (id: string) => number;

    private photos: Photo[] = [];
    private groups: TimelineGroup[] = [];
    private selectedId: string | null = null;
    private selectedIds: Set<string> = new Set();
    private generatingIds = new Set<string>();

    private orientation: 'vertical' | 'horizontal' = 'vertical';
    private sortOrder: 'newest-first' | 'oldest-first' = 'newest-first';
    private gridScale = 1.0;
    private readonly baseRowHeight = 220;
    private readonly baseMinCardWidth = 200;
    private readonly headerHeight = 40;

    private cols = 5;
    private rowCount = 1;
    private visibleGroups: { groupIndex: number, startRow: number, endRow: number }[] = [];
    private lastGroupLayouts: { offset: number, height?: number, rows?: number, width?: number, cols?: number }[] = [];
    private isNavigating = false;

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
        hub.sub(ps.PHOTO_ROTATED, () => this.update(true));
    }

    private get rowHeight() { 
        return (this.baseRowHeight + 10) * this.gridScale; 
    }
    private get minCardWidth() { 
        return (this.baseMinCardWidth + 10) * this.gridScale; 
    }

    public setPhotos(photos: Photo[]) {
        this.photos = [...photos]; 
        this.applySort();
        this.groupPhotos();
        this.vnode = null; // Force full re-render on photo change
        this.update(true);
    }

    public setOrientation(orientation: 'vertical' | 'horizontal') {
        const currentDate = this.getCurrentDate();
        this.orientation = orientation;
        this.vnode = null; // Force full rebuild of legend and groups

        if (this.$viewEl && this.$viewEl.parentElement) {
            const container = this.$viewEl.parentElement;
            if (orientation === 'horizontal') {
                container.scrollTop = 0;
                container.style.overflowX = 'auto';
                container.style.overflowY = 'hidden';
            } else {
                container.scrollLeft = 0;
                container.style.overflowX = 'hidden';
                container.style.overflowY = 'auto';
            }
        }
        
        this.update(true);
        if (currentDate) {
            // Restore position after layout update
            setTimeout(() => this.scrollToDate(currentDate), 10);
        }
    }

    public setSortOrder(order: 'newest-first' | 'oldest-first') {
        if (this.sortOrder === order) return;
        this.sortOrder = order;
        this.applySort();
        this.groupPhotos();
        this.vnode = null;
        this.update(true);
    }

    private applySort() {
        this.photos.sort((a, b) => {
            const timeA = new Date(a.createdAt).getTime();
            const timeB = new Date(b.createdAt).getTime();
            const isAInvalid = isNaN(timeA) || new Date(a.createdAt).getFullYear() > 2035 || new Date(a.createdAt).getFullYear() < 1970;
            const isBInvalid = isNaN(timeB) || new Date(b.createdAt).getFullYear() > 2035 || new Date(b.createdAt).getFullYear() < 1970;
            
            if (isAInvalid && isBInvalid) return 0;
            if (isAInvalid) return 1; 
            if (isBInvalid) return -1;

            return this.sortOrder === 'newest-first' ? timeB - timeA : timeA - timeB;
        });
    }

    public setScale(scale: number) {
        this.gridScale = scale;
        this.update(true);
    }

    private groupPhotos() {
        this.groups = [];
        if (this.photos.length === 0) return;

        let currentGroup: TimelineGroup | null = null;

        for (let i = 0; i < this.photos.length; i++) {
            const photo = this.photos[i];
            const dateObj = new Date(photo.createdAt);
            let dateStr = "Unknown";
            if (!isNaN(dateObj.getTime()) && dateObj.getFullYear() <= 2035 && dateObj.getFullYear() >= 1970) {
                dateStr = dateObj.toISOString().split('T')[0];
            }

            if (!currentGroup || currentGroup.title !== dateStr) {
                currentGroup = {
                    title: dateStr,
                    photos: [],
                    startIndex: i
                };
                this.groups.push(currentGroup);
            }
            currentGroup.photos.push(photo);
        }
    }

    public update(force: boolean = false) {
        if (!this.$viewEl) return;
        const container = this.$viewEl.parentElement as HTMLElement;
        if (!container) return;

        if (this.orientation === 'horizontal') {
            this.updateHorizontal(container, force);
        } else {
            this.updateVertical(container, force);
        }
    }

    private updateVertical(container: HTMLElement, force: boolean) {
        const containerWidth = container.clientWidth - 20;
        this.cols = Math.max(1, Math.floor(containerWidth / this.minCardWidth));
        
        let totalHeight = 0;
        const groupLayouts = this.groups.map(group => {
            const rows = Math.ceil(group.photos.length / this.cols);
            const height = this.headerHeight + (rows * this.rowHeight);
            const offset = totalHeight;
            totalHeight += height;
            return { offset, height, rows };
        });
        this.lastGroupLayouts = groupLayouts;

        if (this.$scrollSentinel) this.$scrollSentinel.style.height = totalHeight + 'px';
        if (this.$scrollSentinel) this.$scrollSentinel.style.width = '1px';

        const scrollTop = container.scrollTop;
        const viewHeight = container.clientHeight;
        const buffer = 200;

        const newVisibleGroups: typeof this.visibleGroups = [];
        for (let i = 0; i < this.groups.length; i++) {
            const layout = groupLayouts[i];
            if (layout.offset + layout.height > scrollTop - buffer && layout.offset < scrollTop + viewHeight + buffer) {
                // This group is visible. Calculate visible rows.
                const groupScrollTop = Math.max(0, scrollTop - layout.offset - this.headerHeight);
                const startRow = Math.max(0, Math.floor(groupScrollTop / this.rowHeight) - 1);
                const endRow = Math.min(layout.rows, Math.ceil((groupScrollTop + viewHeight) / this.rowHeight) + 1);
                
                newVisibleGroups.push({
                    groupIndex: i,
                    startRow,
                    endRow
                });
            }
        }

        // Check if visible groups or their internal row ranges changed
        const isChanged = force || 
            newVisibleGroups.length !== this.visibleGroups.length ||
            newVisibleGroups.some((vg, i) => 
                vg.groupIndex !== this.visibleGroups[i]?.groupIndex ||
                vg.startRow !== this.visibleGroups[i]?.startRow ||
                vg.endRow !== this.visibleGroups[i]?.endRow
            );

        if (isChanged) {
            this.visibleGroups = newVisibleGroups;
            this.renderVertical(groupLayouts);
        }
    }

    private renderVertical(groupLayouts: any[]) {
        if (!this.$viewEl) return;

        const groupNodes: VNode[] = this.visibleGroups.map(vg => {
            const group = this.groups[vg.groupIndex];
            const layout = groupLayouts[vg.groupIndex];
            
            const cards: VNode[] = [];
            const startIndex = vg.startRow * this.cols;
            const endIndex = Math.min(group.photos.length, vg.endRow * this.cols);

            for (let i = startIndex; i < endIndex; i++) {
                const photo = group.photos[i];
                cards.push(
                    <PhotoCard
                        photo={photo}
                        isSelected={this.selectedIds.has(photo.fileEntryId)}
                        isGenerating={this.generatingIds.has(photo.fileEntryId)}
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

            return (
                <div 
                    class={{ 'timeline-group': true }}
                    style={{ 
                        position: 'absolute', top: `${layout.offset}px`, left: '0', right: '0', height: `${layout.height}px`,
                        display: 'flex', flexDirection: 'column'
                    }}
                >
                    <div style={{ height: `${this.headerHeight}px`, display: 'flex', alignItems: 'center', padding: '0 1em', background: 'var(--bg-header)', position: 'sticky', top: '0', zIndex: '5', borderBottom: '1px solid var(--border-dim)' }}>
                        <h4 style={{ margin: '0', color: 'var(--text-bright)' }}>{group.title}</h4>
                        <span style={{ marginLeft: '1em', fontSize: '0.8em', color: 'var(--text-muted)' }}>{group.photos.length} items</span>
                    </div>
                    <div 
                        class={{ 'grid-view': true }}
                        style={{ 
                            display: 'grid', 
                            gridTemplateColumns: `repeat(${this.cols}, 1fr)`,
                            transform: `translateY(${vg.startRow * this.rowHeight}px)`,
                            padding: '5px',
                            flex: '1',
                            overflowY: 'visible' // Override global .grid-view overflow
                        }}
                    >
                        {cards}
                    </div>
                </div>
            );
        });

        // Legend markers
        const legendMarkers: VNode[] = [];
        let currentPositionDate = "";
        
        if (this.groups.length > 0) {
            const container = this.$viewEl.parentElement as HTMLElement;
            const totalHeight = parseFloat(this.$scrollSentinel?.style.height || '0');
            const scrollPct = totalHeight > 0 ? container.scrollTop / totalHeight : 0;
            
            // Find current date for indicator
            for (let i = 0; i < this.groups.length; i++) {
                const layout = groupLayouts[i];
                if (layout.offset <= container.scrollTop || i === 0) {
                    currentPositionDate = this.groups[i].title;
                } else break;
            }

            if (totalHeight > 0) {
                // Determine which markers to show (unique months or years)
                let lastLabel = "";
                for (let i = 0; i < this.groups.length; i++) {
                    const g = this.groups[i];
                    const layout = groupLayouts[i];
                    const date = new Date(g.title);
                    const label = isNaN(date.getTime()) ? "Unknown" : date.getFullYear().toString(); // Year marker
                    
                    if (label !== lastLabel) {
                        const topPercent = (layout.offset / totalHeight) * 100;
                        legendMarkers.push(
                            <div 
                                style={{ 
                                    position: 'absolute', top: `${topPercent}%`, left: '0', right: '0',
                                    padding: '2px 8px', color: 'var(--text-muted)', fontSize: '0.8em', 
                                    fontWeight: 'bold', borderTop: '1px solid rgba(255,255,255,0.15)',
                                    pointerEvents: 'none'
                                }}
                            >
                                {label}
                            </div>
                        );
                        lastLabel = label;
                    }
                }

                // Add Current Position Indicator
                const indicatorTop = scrollPct * 100;
                legendMarkers.push(
                    <div 
                        style={{
                            position: 'absolute', top: `${indicatorTop}%`, left: '0', right: '0',
                            height: '2.5em', transform: 'translateY(-50%)',
                            background: 'var(--accent)', color: 'white', borderRadius: '2px',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.85em', fontWeight: 'bold', zIndex: '10',
                            boxShadow: '0 0 15px rgba(0,120,215,0.5)', pointerEvents: 'none',
                            whiteSpace: 'nowrap', padding: '0 4px', overflow: 'hidden',
                            border: '1px solid rgba(255,255,255,0.3)'
                        }}
                    >
                        {currentPositionDate}
                    </div>
                );
            }
        }

        const newVNode = (
            <div id="timeline-view" style={{ position: 'relative', width: '100%' }}>
                <div 
                    id="timeline-legend"
                    class={{ 'timeline-legend': true }}
                    style={{
                        position: 'fixed', top: '11em', right: '10px', bottom: '40px', width: '6em',
                        background: 'rgba(0,0,0,0.4)', borderRadius: '4px', zIndex: '100',
                        border: '1px solid var(--border-dim)', backdropFilter: 'blur(8px)',
                        transition: 'background 0.2s, border-color 0.2s', cursor: 'ns-resize'
                    }}
                    on={{
                        mousedown: (e: MouseEvent) => {
                            this.isNavigating = true;
                            const legendEl = e.currentTarget as HTMLElement;
                            const container = this.$viewEl?.parentElement as HTMLElement;
                            const totalHeight = parseFloat(this.$scrollSentinel?.style.height || '0');

                            const handleMove = (moveEv: MouseEvent) => {
                                const rect = legendEl.getBoundingClientRect();
                                const pct = Math.max(0, Math.min(1, (moveEv.clientY - rect.top) / rect.height));
                                if (container) container.scrollTop = totalHeight * pct;
                            };

                            const handleUp = () => {
                                this.isNavigating = false;
                                window.removeEventListener('mousemove', handleMove);
                                window.removeEventListener('mouseup', handleUp);
                                this.update(true); // Resume loading and final render
                            };

                            window.addEventListener('mousemove', handleMove);
                            window.addEventListener('mouseup', handleUp);
                            handleMove(e);
                        },
                        wheel: (e: WheelEvent) => {
                            const container = this.$viewEl?.parentElement as HTMLElement;
                            if (container) {
                                e.preventDefault();
                                container.scrollTop += e.deltaY * 5; // 5x faster scroll
                            }
                        }
                    }}
                >
                    {legendMarkers}
                </div>
                {groupNodes}
            </div>
        );

        if (!this.vnode) this.vnode = this.$viewEl;
        this.vnode = patch(this.vnode, newVNode);
        this.$_viewEl = (this.vnode as VNode).elm as HTMLElement;
    }

    private updateHorizontal(container: HTMLElement, force: boolean) {
        const containerHeight = container.clientHeight - 20;
        const rows = Math.max(1, Math.floor(containerHeight / this.rowHeight));
        this.rowCount = rows;
        
        let totalWidth = 0;
        const groupLayouts = this.groups.map(group => {
            const cols = Math.ceil(group.photos.length / rows);
            const width = this.headerHeight + (cols * this.minCardWidth);
            const offset = totalWidth;
            totalWidth += width;
            return { offset, width, cols };
        });
        this.lastGroupLayouts = groupLayouts;

        if (this.$scrollSentinel) this.$scrollSentinel.style.width = totalWidth + 'px';
        if (this.$scrollSentinel) this.$scrollSentinel.style.height = '1px';

        const scrollLeft = container.scrollLeft;
        const viewWidth = container.clientWidth;
        const buffer = 200;

        const newVisibleGroups: typeof this.visibleGroups = [];
        for (let i = 0; i < this.groups.length; i++) {
            const layout = groupLayouts[i];
            if (layout.offset + layout.width > scrollLeft - buffer && layout.offset < scrollLeft + viewWidth + buffer) {
                const groupScrollLeft = Math.max(0, scrollLeft - layout.offset - this.headerHeight);
                const startCol = Math.max(0, Math.floor(groupScrollLeft / this.minCardWidth) - 1);
                const endCol = Math.min(layout.cols, Math.ceil((groupScrollLeft + viewWidth) / this.minCardWidth) + 1);
                
                newVisibleGroups.push({
                    groupIndex: i,
                    startRow: startCol, // Reusing startRow as startCol
                    endRow: endCol      // Reusing endRow as endCol
                });
            }
        }

        const isChanged = force || 
            newVisibleGroups.length !== this.visibleGroups.length ||
            newVisibleGroups.some((vg, i) => 
                vg.groupIndex !== this.visibleGroups[i]?.groupIndex ||
                vg.startRow !== this.visibleGroups[i]?.startRow ||
                vg.endRow !== this.visibleGroups[i]?.endRow
            );

        if (isChanged) {
            this.visibleGroups = newVisibleGroups;
            this.renderHorizontal(groupLayouts, rows);
        }
    }

    private renderHorizontal(groupLayouts: any[], rows: number) {
        if (!this.$viewEl) return;

        const groupNodes: VNode[] = this.visibleGroups.map(vg => {
            const group = this.groups[vg.groupIndex];
            const layout = groupLayouts[vg.groupIndex];
            
            const cards: VNode[] = [];
            const startIdx = vg.startRow * rows;
            const endIdx = Math.min(group.photos.length, vg.endRow * rows);

            for (let i = startIdx; i < endIdx; i++) {
                const photo = group.photos[i];
                cards.push(
                    <PhotoCard
                        photo={photo}
                        isSelected={this.selectedIds.has(photo.fileEntryId)}
                        isGenerating={this.generatingIds.has(photo.fileEntryId)}
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

            return (
                <div 
                    class={{ 'timeline-group-horiz': true }}
                    style={{ 
                        position: 'absolute', left: `${layout.offset}px`, top: '0', bottom: '0', width: `${layout.width}px`,
                        display: 'flex', flexDirection: 'row'
                    }}
                >
                    <div style={{ width: `${this.headerHeight}px`, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-header)', borderRight: '1px solid var(--border-dim)', writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}>
                        <h4 style={{ margin: '0', color: 'var(--text-bright)' }}>{group.title}</h4>
                    </div>
                    <div 
                        class={{ 'grid-view': true }}
                        style={{ 
                            display: 'grid', 
                            gridTemplateColumns: `repeat(${vg.endRow - vg.startRow}, ${this.minCardWidth - 10}px)`,
                            gridTemplateRows: `repeat(${rows}, 1fr)`,
                            gridAutoFlow: 'column',
                            transform: `translateX(${vg.startRow * this.minCardWidth}px)`,
                            padding: '5px',
                            flex: '1',
                            overflowY: 'visible' // Override global .grid-view overflow
                        }}
                    >
                        {cards}
                    </div>
                </div>
            );
        });

        // Horizontal Legend markers
        const legendMarkers: VNode[] = [];
        let currentPositionDate = "";

        if (this.groups.length > 0) {
            const container = this.$viewEl.parentElement as HTMLElement;
            const totalWidth = parseFloat(this.$scrollSentinel?.style.width || '0');
            const scrollPct = totalWidth > 0 ? container.scrollLeft / totalWidth : 0;

            // Find current date for indicator
            for (let i = 0; i < this.groups.length; i++) {
                const layout = groupLayouts[i];
                if (layout.offset <= container.scrollLeft || i === 0) {
                    currentPositionDate = this.groups[i].title;
                } else break;
            }

            if (totalWidth > 0) {
                let lastLabel = "";
                for (let i = 0; i < this.groups.length; i++) {
                    const g = this.groups[i];
                    const layout = groupLayouts[i];
                    const date = new Date(g.title);
                    const label = isNaN(date.getTime()) ? "Unknown" : date.getFullYear().toString();
                    
                    if (label !== lastLabel) {
                        const leftPercent = (layout.offset / totalWidth) * 100;
                        legendMarkers.push(
                            <div 
                                style={{ 
                                    position: 'absolute', left: `${leftPercent}%`, top: '0', bottom: '0',
                                    padding: '4px 8px', color: 'var(--text-muted)', fontSize: '0.8em', 
                                    fontWeight: 'bold', borderLeft: '1px solid rgba(255,255,255,0.15)',
                                    pointerEvents: 'none', writingMode: 'vertical-lr', transform: 'rotate(180deg)'
                                }}
                            >
                                {label}
                            </div>
                        );
                        lastLabel = label;
                    }
                }

                // Add Current Position Indicator
                const indicatorLeft = scrollPct * 100;
                legendMarkers.push(
                    <div 
                        style={{
                            position: 'absolute', left: `${indicatorLeft}%`, top: '0', bottom: '0',
                            width: '2.5em', 
                            background: 'var(--accent)', color: 'white', borderRadius: '2px',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.85em', fontWeight: 'bold', zIndex: '10',
                            boxShadow: '0 0 15px rgba(0,120,215,0.5)', pointerEvents: 'none',
                            whiteSpace: 'nowrap', padding: '4px 0', overflow: 'hidden',
                            writingMode: 'vertical-lr', transform: 'translateX(-50%) rotate(180deg)',
                            border: '1px solid rgba(255,255,255,0.3)'
                        }}
                    >
                        {currentPositionDate}
                    </div>
                );
            }
        }

        const newVNode = (
            <div id="timeline-view" style={{ position: 'relative', height: '100%' }}>
                <div 
                    id="timeline-legend-horiz"
                    class={{ 'timeline-legend': true }}
                    style={{
                        position: 'fixed', left: '100px', right: '100px', bottom: '10px', height: '6em',
                        background: 'rgba(0,0,0,0.4)', borderRadius: '4px', zIndex: '100',
                        border: '1px solid var(--border-dim)', backdropFilter: 'blur(8px)',
                        transition: 'background 0.2s, border-color 0.2s', cursor: 'ew-resize'
                    }}
                    on={{
                        mousedown: (e: MouseEvent) => {
                            this.isNavigating = true;
                            const legendEl = e.currentTarget as HTMLElement;
                            const container = this.$viewEl?.parentElement as HTMLElement;
                            const totalWidth = parseFloat(this.$scrollSentinel?.style.width || '0');

                            const handleMove = (moveEv: MouseEvent) => {
                                const rect = legendEl.getBoundingClientRect();
                                const pct = Math.max(0, Math.min(1, (moveEv.clientX - rect.left) / rect.width));
                                if (container) container.scrollLeft = totalWidth * pct;
                            };

                            const handleUp = () => {
                                this.isNavigating = false;
                                window.removeEventListener('mousemove', handleMove);
                                window.removeEventListener('mouseup', handleUp);
                                this.update(true);
                            };

                            window.addEventListener('mousemove', handleMove);
                            window.addEventListener('mouseup', handleUp);
                            handleMove(e);
                        },
                        wheel: (e: WheelEvent) => {
                            const container = this.$viewEl?.parentElement as HTMLElement;
                            if (container) {
                                e.preventDefault();
                                // Support both standard horizontal scroll and vertical-to-horizontal redirection
                                const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
                                container.scrollLeft += delta * 5; // 5x faster scroll
                            }
                        }
                    }}
                >
                    {legendMarkers}
                </div>
                {groupNodes}
            </div>
        );

        if (!this.vnode) this.vnode = this.$viewEl;
        this.vnode = patch(this.vnode, newVNode);
        this.$_viewEl = (this.vnode as VNode).elm as HTMLElement;
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

    public lazyLoadImage(id: string, img: HTMLImageElement, size: number) {
        if (this.isNavigating) return;

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
            img.src = url;
            img.onload = () => {
                img.parentElement?.classList.add('loaded');
                const card = img.closest('.card');
                if (card) {
                    card.classList.remove('loading');
                    card.classList.remove('generating');
                }
            };
            img.onerror = () => {
                img.closest('.card')?.classList.remove('loading');
            };
        }).catch(() => {
            img.closest('.card')?.classList.remove('loading');
        });
    }

    public getCurrentDate(): string | null {
        if (!this.$viewEl || !this.$viewEl.parentElement || this.groups.length === 0) return null;
        const container = this.$viewEl.parentElement;
        const currentScroll = this.orientation === 'horizontal' ? container.scrollLeft : container.scrollTop;

        // Find group at current scroll position
        let bestGroup = this.groups[0];
        for (let i = 0; i < this.groups.length; i++) {
            const layout = this.lastGroupLayouts[i];
            if (layout.offset <= currentScroll) {
                bestGroup = this.groups[i];
            } else break;
        }
        return bestGroup.title;
    }

    public scrollToDate(date: string) {
        if (!this.$viewEl || !this.$viewEl.parentElement) return;
        const groupIndex = this.groups.findIndex(g => g.title === date);
        if (groupIndex === -1 || !this.lastGroupLayouts[groupIndex]) return;

        const container = this.$viewEl.parentElement;
        const layout = this.lastGroupLayouts[groupIndex];
        
        if (this.orientation === 'horizontal') {
            container.scrollLeft = layout.offset;
        } else {
            container.scrollTop = layout.offset;
        }
        this.update(true);
    }

    public getScrollProgress(): number {
        if (!this.$viewEl || !this.$viewEl.parentElement) return 0;
        const container = this.$viewEl.parentElement;
        if (this.orientation === 'horizontal') {
            const totalWidth = parseFloat(this.$scrollSentinel?.style.width || '0');
            return totalWidth > 0 ? container.scrollLeft / totalWidth : 0;
        } else {
            const totalHeight = parseFloat(this.$scrollSentinel?.style.height || '0');
            return totalHeight > 0 ? container.scrollTop / totalHeight : 0;
        }
    }

    public setScrollProgress(progress: number) {
        if (!this.$viewEl || !this.$viewEl.parentElement) return;
        const container = this.$viewEl.parentElement;
        if (this.orientation === 'horizontal') {
            const totalWidth = parseFloat(this.$scrollSentinel?.style.width || '0');
            container.scrollLeft = totalWidth * progress;
        } else {
            const totalHeight = parseFloat(this.$scrollSentinel?.style.height || '0');
            container.scrollTop = totalHeight * progress;
        }
        this.update(true);
    }

    public getColumnCount() {
        return this.cols;
    }

    public getRowCount() {
        return this.rowCount;
    }

    public getOrientation() {
        return this.orientation;
    }

    public getNavigationId(currentId: string | null, key: string): string | null {
        if (!currentId || this.photos.length === 0) return null;

        const currentIndex = this.photos.findIndex(p => p.fileEntryId === currentId);
        if (currentIndex === -1) return null;

        const isHorizontal = this.orientation === 'horizontal';
        
        // Use stored metrics
        const cols = this.cols;
        const rows = this.rowCount;

        const groupIndex = this.groups.findIndex((g, i) => 
            currentIndex >= g.startIndex && (i === this.groups.length - 1 || currentIndex < this.groups[i+1].startIndex)
        );
        if (groupIndex === -1) return currentId;

        const group = this.groups[groupIndex];
        const idxInGroup = currentIndex - group.startIndex;

        let nextIndex = currentIndex;
        if (isHorizontal) {
            nextIndex = this.getHorizNavigationIndex(currentIndex, key, groupIndex, idxInGroup, rows);
        } else {
            nextIndex = this.getVertNavigationIndex(currentIndex, key, groupIndex, idxInGroup, cols);
        }

        return this.photos[nextIndex].fileEntryId;
    }

    private getHorizNavigationIndex(currentIndex: number, key: string, groupIndex: number, idxInGroup: number, rows: number): number {
        const group = this.groups[groupIndex];
        const currentCol = Math.floor(idxInGroup / rows);
        const currentRow = idxInGroup % rows;
        const totalColsInGroup = Math.ceil(group.photos.length / rows);

        if (key === 'ArrowDown') {
            // Next row in same column, no wrap
            if (currentRow < rows - 1 && idxInGroup + 1 < group.photos.length) return currentIndex + 1;
            return currentIndex;
        }
        if (key === 'ArrowUp') {
            // Prev row in same column, no wrap
            if (currentRow > 0) return currentIndex - 1;
            return currentIndex;
        }
        if (key === 'ArrowRight') {
            if (currentCol < totalColsInGroup - 1) {
                // Next column in same group
                const nextColStart = (currentCol + 1) * rows;
                // If next column is partially full, clamp to last item
                return group.startIndex + Math.min(nextColStart + currentRow, group.photos.length - 1);
            } else if (groupIndex < this.groups.length - 1) {
                // Next group, first column, same row (clamped to available items in that group's first column)
                const nextGroup = this.groups[groupIndex + 1];
                // In horizontal mode, first column is items 0..rows-1. We want Row 'currentRow'.
                return nextGroup.startIndex + Math.min(currentRow, nextGroup.photos.length - 1);
            }
        }
        if (key === 'ArrowLeft') {
            if (currentCol > 0) {
                // Prev column in same group
                const prevColStart = (currentCol - 1) * rows;
                return group.startIndex + prevColStart + currentRow;
            } else if (groupIndex > 0) {
                // Prev group, last column, same row (clamped)
                const prevGroup = this.groups[groupIndex - 1];
                const lastCol = Math.floor((prevGroup.photos.length - 1) / rows);
                const lastColStart = lastCol * rows;
                return prevGroup.startIndex + Math.min(lastColStart + currentRow, prevGroup.photos.length - 1);
            }
        }
        return currentIndex;
    }

    private getVertNavigationIndex(currentIndex: number, key: string, groupIndex: number, idxInGroup: number, cols: number): number {
        const group = this.groups[groupIndex];
        const currentRow = Math.floor(idxInGroup / cols);
        const currentCol = idxInGroup % cols;
        const totalRowsInGroup = Math.ceil(group.photos.length / cols);

        if (key === 'ArrowRight') {
            // Next col in same row, no wrap
            if (currentCol < cols - 1 && idxInGroup + 1 < group.photos.length) return currentIndex + 1;
            return currentIndex;
        }
        if (key === 'ArrowLeft') {
            // Prev col in same row, no wrap
            if (currentCol > 0) return currentIndex - 1;
            return currentIndex;
        }
        if (key === 'ArrowDown') {
            if (currentRow < totalRowsInGroup - 1) {
                // Next row in same group
                const nextRowStart = (currentRow + 1) * cols;
                return group.startIndex + Math.min(nextRowStart + currentCol, group.photos.length - 1);
            } else if (groupIndex < this.groups.length - 1) {
                // Next group, first row, same col (clamped)
                const nextGroup = this.groups[groupIndex + 1];
                return nextGroup.startIndex + Math.min(currentCol, nextGroup.photos.length - 1);
            }
        }
        if (key === 'ArrowUp') {
            if (currentRow > 0) {
                // Prev row in same group
                const prevRowStart = (currentRow - 1) * cols;
                return group.startIndex + prevRowStart + currentCol;
            } else if (groupIndex > 0) {
                // Prev group, last row, same col (clamped)
                const prevGroup = this.groups[groupIndex - 1];
                const lastRow = Math.floor((prevGroup.photos.length - 1) / cols);
                const lastRowStart = lastRow * cols;
                return prevGroup.startIndex + Math.min(lastRowStart + currentCol, prevGroup.photos.length - 1);
            }
        }
        return currentIndex;
    }

    public scrollToPhoto(id: string) {
        let groupIndex = -1;
        let photoIndexInGroup = -1;

        for (let i = 0; i < this.groups.length; i++) {
            const idx = this.groups[i].photos.findIndex(p => p.fileEntryId === id);
            if (idx !== -1) {
                groupIndex = i;
                photoIndexInGroup = idx;
                break;
            }
        }

        if (groupIndex === -1 || !this.lastGroupLayouts[groupIndex] || !this.$viewEl) return;

        const container = this.$viewEl.parentElement as HTMLElement;
        if (!container) return;

        const layout = this.lastGroupLayouts[groupIndex];
        
        if (this.orientation === 'horizontal') {
            const containerHeight = container.clientHeight - 20;
            const rows = Math.max(1, Math.floor(containerHeight / this.rowHeight));
            const colInGroup = Math.floor(photoIndexInGroup / rows);
            const targetLeft = layout.offset + this.headerHeight + (colInGroup * this.minCardWidth);
            
            const currentScroll = container.scrollLeft;
            const viewWidth = container.clientWidth;

            if (targetLeft < currentScroll || targetLeft + this.minCardWidth > currentScroll + viewWidth) {
                container.scrollTo({
                    left: targetLeft - (viewWidth / 2) + (this.minCardWidth / 2),
                    behavior: 'smooth'
                });
            }
        } else {
            const rowInGroup = Math.floor(photoIndexInGroup / this.cols);
            const targetTop = layout.offset + this.headerHeight + (rowInGroup * this.rowHeight);
            
            const currentScroll = container.scrollTop;
            const viewHeight = container.clientHeight;

            if (targetTop < currentScroll || targetTop + this.rowHeight > currentScroll + viewHeight) {
                container.scrollTo({
                    top: targetTop - (viewHeight / 2) + (this.rowHeight / 2),
                    behavior: 'smooth'
                });
            }
        }
    }
}
