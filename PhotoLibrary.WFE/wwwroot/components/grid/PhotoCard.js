import { h } from '../../snabbdom-setup.js';
export function PhotoCard(props) {
    const { photo, isSelected, isGenerating, rotation, mode, imageUrlCache } = props;
    // console.log(`[PhotoCard] ${photo.id} isPicked=${photo.isPicked}`);
    const rotStyle = rotation ? { transform: `rotate(${rotation}deg)` } : {};
    const isPortrait = rotation % 180 !== 0;
    const cacheKey = photo.id + '-300';
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
            click: (e) => {
                e.stopPropagation();
                props.onSelect(photo.id, photo, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
            },
            dblclick: () => { if (mode === 'grid')
                props.onDoubleClick(photo.id); },
            contextmenu: (e) => { e.preventDefault(); props.onContextMenu(e, photo); }
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
                            window.app.gridViewManager.lazyLoadImage(photo.id, vnode.elm, 300);
                        }
                    },
                    update: (oldVnode, vnode) => {
                        const oldId = oldVnode.elm?.parentElement?.dataset?.id;
                        if (photo.id !== oldId && !cachedUrl) {
                            window.app.gridViewManager.lazyLoadImage(photo.id, vnode.elm, 300);
                        }
                    }
                }
            })
        ]),
        photo.stackCount > 1 ? h('div.stack-badge', photo.stackCount.toString()) : null,
        h('div.info', [
            h('div.info-top', [
                h('span.filename', getDisplayName()),
                h('div', { style: { display: 'flex', gap: '0.2em' } }, [
                    h('span.rotate-btn', {
                        style: { cursor: 'pointer', color: 'var(--text-muted)', fontSize: '1.1em', padding: '0 2px' },
                        attrs: { title: 'Rotate Left ([)' },
                        on: { click: (e) => { e.stopPropagation(); props.onRotate(photo, rotation - 90); } }
                    }, '\u21BA'),
                    h('span.rotate-btn', {
                        style: { cursor: 'pointer', color: 'var(--text-muted)', fontSize: '1.1em', padding: '0 2px' },
                        attrs: { title: 'Rotate Right (])' },
                        on: { click: (e) => { e.stopPropagation(); props.onRotate(photo, rotation + 90); } }
                    }, '\u21BB')
                ])
            ]),
            h('div.info-mid', new Date(photo.createdAt).toISOString().split('T')[0]),
            h('div.info-bottom', [
                h('span', {
                    class: { 'pick-btn': true, picked: !!photo.isPicked },
                    attrs: { title: photo.isPicked ? 'Unpick (P)' : 'Pick (P)' },
                    on: { click: (e) => { e.stopPropagation(); props.onTogglePick(photo); } }
                }, '\u2691'),
                h('div', {
                    class: { 'stars-interactive': true, 'has-rating': (photo.rating || 0) > 0 }
                }, [5, 4, 3, 2, 1].map(star => h('span', {
                    class: { star: true, active: star <= (photo.rating || 0) },
                    attrs: { title: `Rate ${star} (${star})` },
                    on: { click: (e) => { e.stopPropagation(); props.onRate(photo, star); } }
                }, '\u2605')))
            ])
        ])
    ]);
}
