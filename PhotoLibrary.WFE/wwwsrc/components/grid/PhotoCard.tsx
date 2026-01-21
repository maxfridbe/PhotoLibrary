/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';

export interface PhotoCardProps {
    photo: Res.PhotoResponse;
    isSelected: boolean;
    isGenerating: boolean;
    rotation: number;
    mode: 'grid' | 'filmstrip';
    imageUrlCache: Map<string, string>;
    onSelect: (id: string, photo: Res.PhotoResponse, modifiers: { shift: boolean, ctrl: boolean }) => void;
    onDoubleClick: (id: string) => void;
    onContextMenu: (e: MouseEvent, photo: Res.PhotoResponse) => void;
    onTogglePick: (photo: Res.PhotoResponse) => void;
    onRate: (photo: Res.PhotoResponse, rating: number) => void;
    onRotate: (photo: Res.PhotoResponse, rotation: number) => void;
}

export function PhotoCard(props: PhotoCardProps): VNode {
    const { photo, isSelected, isGenerating, rotation, mode, imageUrlCache } = props;

    const rotStyle = rotation ? { transform: `rotate(${rotation}deg)` } : {};
    const isPortrait = rotation % 180 !== 0;

    const cacheKey = photo.fileEntryId + '-300';
    const cachedUrl = imageUrlCache.get(cacheKey);

    const getDisplayName = () => {
        if (photo.stackCount > 1 && photo.stackExtensions) {
            const name = photo.fileName || '';
            const lastDot = name.lastIndexOf('.');
            const base = lastDot > 0 ? name.substring(0, lastDot) : name;
            return `${base} (${photo.stackExtensions})`;
        }
        return photo.fileName || '';
    };

    return (
        <div 
            key={`${mode}-${photo.fileEntryId}`}
            class={{
                card: true,
                selected: isSelected,
                generating: isGenerating,
                'is-stacked': photo.stackCount > 1,
                loading: !cachedUrl
            }}
            dataset={{ id: photo.fileEntryId }}
            on={{
                click: (e: MouseEvent) => {
                    e.stopPropagation();
                    props.onSelect(photo.fileEntryId, photo, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
                },
                dblclick: () => { if (mode === 'grid') props.onDoubleClick(photo.fileEntryId); },
                contextmenu: (e: MouseEvent) => { e.preventDefault(); props.onContextMenu(e, photo); }
            }}
        >
            <div class={{ 'img-container': true, loaded: !!cachedUrl }}>
                <div class={{ 'card-spinner': true }} />
                <img 
                    style={rotStyle}
                    class={{ 'is-portrait-rotated': isPortrait }}
                    props={{ src: cachedUrl || '' }}
                    hook={{
                        insert: (vnode) => {
                            if (!cachedUrl) {
                                window.app.gridViewManager.lazyLoadImage(photo.fileEntryId, vnode.elm as HTMLImageElement, 300);
                            }
                        },
                        update: (oldVnode, vnode) => {
                            const oldId = (oldVnode.elm?.parentElement as HTMLElement)?.dataset?.id;
                            if (photo.fileEntryId !== oldId && !cachedUrl) {
                                window.app.gridViewManager.lazyLoadImage(photo.fileEntryId, vnode.elm as HTMLImageElement, 300);
                            }
                        }
                    }}
                />
            </div>
            {photo.stackCount > 1 ? <div class={{ 'stack-badge': true }}>{photo.stackCount.toString()}</div> : null}
            <div class={{ info: true }}>
                <div class={{ 'info-top': true }}>
                    <span class={{ filename: true }}>{getDisplayName()}</span>
                    <div style={{ display: 'flex', gap: '0.2em' }}>
                        <span 
                            class={{ 'rotate-btn': true }}
                            style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: '1.1em', padding: '0 2px' }}
                            attrs={{ title: 'Rotate Left ([)' }}
                            on={{ click: (e: MouseEvent) => { e.stopPropagation(); props.onRotate(photo, rotation - 90); } }}
                        >
                            {'\u21BA'}
                        </span>
                        <span 
                            class={{ 'rotate-btn': true }}
                            style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: '1.1em', padding: '0 2px' }}
                            attrs={{ title: 'Rotate Right (])' }}
                            on={{ click: (e: MouseEvent) => { e.stopPropagation(); props.onRotate(photo, rotation + 90); } }}
                        >
                            {'\u21BB'}
                        </span>
                    </div>
                </div>
                <div class={{ 'info-mid': true }}>{new Date(photo.createdAt).toISOString().split('T')[0]}</div>
                <div class={{ 'info-bottom': true }}>
                    <span 
                        class={{ 'pick-btn': true, picked: !!photo.isPicked }}
                        attrs={{ title: photo.isPicked ? 'Unpick (P)' : 'Pick (P)' }}
                        on={{ click: (e: MouseEvent) => { e.stopPropagation(); props.onTogglePick(photo); } }}
                    >
                        {'\u2691'}
                    </span>
                    <div class={{ 'stars-interactive': true, 'has-rating': (photo.rating || 0) > 0 }}>
                        {[5, 4, 3, 2, 1].map(star => (
                            <span 
                                class={{ star: true, active: star <= (photo.rating || 0) }}
                                attrs={{ title: `Rate ${star} (${star})` }}
                                on={{ click: (e: MouseEvent) => { e.stopPropagation(); props.onRate(photo, star); } }}
                            >
                                {'\u2605'}
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
