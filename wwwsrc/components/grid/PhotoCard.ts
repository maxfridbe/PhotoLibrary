import { h, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';

export interface PhotoCardProps {
    photo: Res.PhotoResponse;
    isSelected: boolean;
    isGenerating: boolean;
    rotation: number;
    mode: 'grid' | 'filmstrip';
    imageUrlCache: Map<string, string>;
    onSelect: (id: string, photo: Res.PhotoResponse) => void;
    onDoubleClick: (id: string) => void;
    onContextMenu: (e: MouseEvent, photo: Res.PhotoResponse) => void;
    onTogglePick: (photo: Res.PhotoResponse) => void;
}

export function PhotoCard(props: PhotoCardProps): VNode {
    const { photo, isSelected, isGenerating, rotation, mode, imageUrlCache } = props;

    const rotStyle = rotation ? { transform: `rotate(${rotation}deg)` } : {};
    const isPortrait = rotation % 180 !== 0;

    const cacheKey = photo.id + '-300';
    const cachedUrl = imageUrlCache.get(cacheKey);

    return h('div.card', {
        key: `${mode}-${photo.id}`,
        class: {
            selected: isSelected,
            generating: isGenerating,
            'is-stacked': photo.stackCount > 1,
            loading: !cachedUrl
        },
        dataset: { id: photo.id },
        on: {
            click: () => props.onSelect(photo.id, photo),
            dblclick: () => { if (mode === 'grid') props.onDoubleClick(photo.id); },
            contextmenu: (e: MouseEvent) => { e.preventDefault(); props.onContextMenu(e, photo); }
        }
    }, [
        h('div.img-container', {
            class: { loaded: !!cachedUrl }
        }, [
            h('div.card-spinner'),
            h('img', {
                style: rotStyle,
                class: { 'is-portrait-rotated': isPortrait },
                props: { src: cachedUrl || '' },
                hook: {
                    insert: (vnode) => {
                        if (!cachedUrl) {
                            window.app.gridViewManager.lazyLoadImage(photo.id, vnode.elm as HTMLImageElement, 300);
                        }
                    },
                    update: (oldVnode, vnode) => {
                        const oldId = (oldVnode.data as any)?.dataset?.id;
                        if (photo.id !== oldId && !cachedUrl) {
                            window.app.gridViewManager.lazyLoadImage(photo.id, vnode.elm as HTMLImageElement, 300);
                        }
                    }
                }
            })
        ]),
        photo.stackCount > 1 ? h('div.stack-badge', photo.stackCount.toString()) : null,
        h('div.info', [
            h('div.info-top', [
                h('span.filename', photo.fileName || ''),
                h('span.pick-btn', {
                    class: { picked: photo.isPicked },
                    on: { click: (e: MouseEvent) => { e.stopPropagation(); props.onTogglePick(photo); } }
                }, '\u2691')
            ]),
            h('div.info-mid', new Date(photo.createdAt).toISOString().split('T')[0]),
            h('div.info-bottom', [
                h('span.stars', {
                    class: { 'has-rating': photo.rating > 0 }
                }, photo.rating > 0 ? '\u2605'.repeat(photo.rating) : '\u2606\u2606\u2606\u2606\u2606')
            ])
        ])
    ]);
}
