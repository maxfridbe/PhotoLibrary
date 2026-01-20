import { h, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';
import { server } from '../../CommunicationManager.js';
import * as Api from '../../Functions.generated.js';
import { hub } from '../../PubSub.js';
import { constants } from '../../constants.js';
import { AppHTMLElement, LoupeLogic, LoupeViewProps } from '../../types.js';

const ps = constants.pubsub;

export function LoupeView(props: LoupeViewProps): VNode {
    const { photo, rotation, overlayText, isVisible } = props;

    if (!photo) return h('div#loupe-view.loupe-view', { style: { display: isVisible ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center', height: '100%' } }, 'No photo selected');

    return h('div#loupe-view.loupe-view', {
        key: 'loupe-view',
        style: { 
            height: '100%', position: 'relative', overflow: 'hidden', background: '#000', 
            display: isVisible ? 'flex' : 'none' 
        },
        hook: {
            insert: (vnode) => {
                const $el = vnode.elm as AppHTMLElement;
                $el._loupeLogic = setupLoupeLogic($el, props);
            },
            update: (oldVnode, vnode) => {
                const $el = vnode.elm as AppHTMLElement;
                const oldId = oldVnode.data?.dataset?.id;
                if (oldId !== photo.id) {
                    if ((oldVnode.elm as AppHTMLElement)?._loupeLogic) (oldVnode.elm as AppHTMLElement)._loupeLogic!.destroy();
                    $el._loupeLogic = setupLoupeLogic($el, props);
                } else if ($el._loupeLogic) {
                    $el._loupeLogic.updateProps(props);
                }
            },
            destroy: (vnode) => {
                if ((vnode.elm as AppHTMLElement)?._loupeLogic) (vnode.elm as AppHTMLElement)._loupeLogic!.destroy();
            }
        },
        dataset: { id: photo.id }
    }, [
        h('div.preview-area', { 
            style: { width: '100%', height: '100%', position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '1' }
        }, [
            h('div#preview-spinner.spinner.center-spinner', { style: { display: 'none' } }),
            h('div#loupe-overlay.loupe-overlay', { 
                props: { textContent: overlayText },
                style: { position: 'absolute', top: '10px', left: '10px', color: 'white', textShadow: '1px 1px 2px black', zIndex: '10', pointerEvents: 'none', whiteSpace: 'pre-wrap', fontSize: '0.9em' }
            }),
            h('img#loupe-preview-placeholder.loupe-img.placeholder', {
                class: { 'is-portrait-rotated': rotation % 180 !== 0 },
                style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
            }),
            h('img#main-preview.loupe-img.highres', {
                class: { 'is-portrait-rotated': rotation % 180 !== 0 },
                style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', position: 'absolute', opacity: '0', transition: 'opacity 0.3s' }
            }),
            // Zoom Toolbar
            h('div.zoom-toolbar', {
                style: {
                    position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
                    background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(5px)', padding: '5px 15px',
                    borderRadius: '20px', display: 'flex', gap: '15px', alignItems: 'center',
                    color: 'white', opacity: '0', transition: 'opacity 0.3s', pointerEvents: 'none',
                    zIndex: '100', border: '1px solid rgba(255,255,255,0.2)'
                }
            }, [
                h('span.btn-rotate-left', { 
                    props: { innerHTML: '&#8634;', title: 'Rotate Left ([)' }, 
                    style: { cursor: 'pointer', fontWeight: 'bold', padding: '0 5px', pointerEvents: 'auto', fontSize: '1.2em' }
                }),
                h('span.btn-minus', { 
                    props: { textContent: '-', title: 'Zoom Out' },
                    style: { cursor: 'pointer', fontWeight: 'bold', padding: '0 5px', pointerEvents: 'auto' }
                }),
                h('span.zoom-level', { 
                    props: { textContent: '100%' },
                    style: { fontVariantNumeric: 'tabular-nums', width: '3em', textAlign: 'center' }
                }),
                h('span.btn-plus', { 
                    props: { textContent: '+', title: 'Zoom In' },
                    style: { cursor: 'pointer', fontWeight: 'bold', padding: '0 5px', pointerEvents: 'auto' }
                }),
                h('span.btn-1to1', { 
                    props: { textContent: '1:1', title: 'Zoom to Device Pixels' },
                    style: { cursor: 'pointer', fontWeight: 'bold', padding: '0 5px', pointerEvents: 'auto', fontSize: '0.8em', border: '1px solid white', borderRadius: '4px', display: 'none' }
                }),
                h('span.btn-rotate-right', { 
                    props: { innerHTML: '&#8635;', title: 'Rotate Right (])' },
                    style: { cursor: 'pointer', fontWeight: 'bold', padding: '0 5px', pointerEvents: 'auto', fontSize: '1.2em' }
                })
            ])
        ])
    ]);
}

function setupLoupeLogic($el: AppHTMLElement, initialProps: LoupeViewProps) {
    let props = initialProps;
    const { photo, imageUrlCache } = props;
    if (!photo) return { destroy: () => {}, updateProps: () => {} };

    const $previewArea = $el.querySelector('.preview-area') as HTMLElement;
    const $imgP = $el.querySelector('#loupe-preview-placeholder') as HTMLImageElement;
    const $imgH = $el.querySelector('#main-preview') as HTMLImageElement;
    const $spinner = $el.querySelector('#preview-spinner') as HTMLElement;
    const $zoomToolbar = $el.querySelector('.zoom-toolbar') as HTMLElement;
    const $zoomLevel = $el.querySelector('.zoom-level') as HTMLElement;
    const $btnPlus = $el.querySelector('.btn-plus') as HTMLElement;
    const $btnMinus = $el.querySelector('.btn-minus') as HTMLElement;
    const $btn1to1 = $el.querySelector('.btn-1to1') as HTMLElement;
    const $btnRotateLeft = $el.querySelector('.btn-rotate-left') as HTMLElement;
    const $btnRotateRight = $el.querySelector('.btn-rotate-right') as HTMLElement;

    let scale = 1;
    let rotation = props.rotation;
    let pX = 0, pY = 0;
    let isDragging = false;
    let startX = 0, startY = 0;
    let zoomTimer: any = null;
    let isFullResLoaded = false;
    let savePrefsTimer: any = null;

    const showToolbar = () => {
        $zoomToolbar.style.opacity = '1';
        if (zoomTimer) clearTimeout(zoomTimer);
        zoomTimer = setTimeout(() => $zoomToolbar.style.opacity = '0', 2000);
    };

    const saveViewPrefs = () => {
        if (!photo || !photo.hash) return;
        if (rotation === 0 && scale === 1 && pX === 0 && pY === 0) return;

        const prefs = {
            rotation,
            zoom: scale,
            panL: pX / $previewArea.clientWidth,
            panT: pY / $previewArea.clientHeight
        };

        Api.api_settings_set({ 
            key: `${photo.hash}-pref-img`, 
            value: JSON.stringify(prefs) 
        });
    };

    const updateTransform = (skipSave = false, skipTransition = false) => {
        const transform = `translate(${pX}px, ${pY}px) scale(${scale}) rotate(${rotation}deg)`;
        
        $imgP.style.transition = skipTransition || isDragging ? 'none' : 'transform 0.2s';
        $imgH.style.transition = skipTransition || isDragging ? 'none' : 'transform 0.2s';
        
        $imgP.style.transform = transform;
        $imgH.style.transform = transform;
        $zoomLevel.textContent = Math.round(scale * 100) + '%';
        
        if (scale > 1) $previewArea.style.cursor = isDragging ? 'grabbing' : 'grab';
        else $previewArea.style.cursor = 'default';

        if (scale > 1.5 && !isFullResLoaded) {
            loadFullRes();
        }

        if (!skipSave) {
            if (savePrefsTimer) clearTimeout(savePrefsTimer);
            savePrefsTimer = setTimeout(saveViewPrefs, 1000);
        }
    };

    const loadFullRes = () => {
        if (isFullResLoaded) return;
        isFullResLoaded = true;
        
        const fullResKey = photo.id + '-0';
        
        const applyFullRes = (url: string) => {
            $imgH.src = url;
            const onLoaded = () => {
                $imgH.style.opacity = '1';
                $btn1to1.style.display = 'inline-block';
                showToolbar();
            };
            if ($imgH.complete) onLoaded();
            else $imgH.onload = onLoaded;
        };

        if (imageUrlCache.has(fullResKey)) {
            applyFullRes(imageUrlCache.get(fullResKey)!);
        } else {
            server.requestImage(photo.id, 0).then((blob: Blob) => {
                const url = URL.createObjectURL(blob);
                imageUrlCache.set(fullResKey, url);
                applyFullRes(url);
            });
        }
    };

    const loadImages = () => {
        const lowResKey = photo.id + '-300';
        const highResKey = photo.id + '-1024';

        $spinner.style.display = 'block';
        $imgH.style.opacity = '0';
        $imgH.src = '';
        $imgP.src = '';

        const requestHighRes = () => {
            const priority = window.app?.getPriority?.(photo.id) || 10;
            server.requestImage(photo.id, 1024, priority).then((blob: Blob) => {
                const url = URL.createObjectURL(blob);
                imageUrlCache.set(highResKey, url);
                $imgH.src = url;
                const onLoaded = () => {
                    $imgH.style.opacity = '1';
                    $spinner.style.display = 'none';
                };
                if ($imgH.complete) onLoaded();
                else $imgH.onload = onLoaded;
            });
        };

        if (imageUrlCache.has(highResKey)) {
            const url = imageUrlCache.get(highResKey)!;
            $imgH.src = url;
            $imgH.style.opacity = '1';
            $spinner.style.display = 'none';
        } else if (imageUrlCache.has(lowResKey)) {
            const url = imageUrlCache.get(lowResKey)!;
            $imgP.src = url;
            requestHighRes();
        } else {
            const priority = window.app?.getPriority?.(photo.id) || 10;
            server.requestImage(photo.id, 300, priority).then((blob: Blob) => {
                const url = URL.createObjectURL(blob);
                imageUrlCache.set(lowResKey, url);
                $imgP.src = url;
                requestHighRes();
            });
        }
    };

    const triggerRotate = (dir: number) => {
        rotation += dir;
        updateTransform();
        showToolbar();
        props.onRotate(photo.id, rotation);
    };

    $btnPlus.onclick = (e) => { e.stopPropagation(); scale = Math.min(5, scale + 0.1); updateTransform(); showToolbar(); };
    $btnMinus.onclick = (e) => { e.stopPropagation(); scale = Math.max(0.1, scale - 0.1); if(scale<=1) { pX=0; pY=0; } updateTransform(); showToolbar(); };
    $btnRotateLeft.onclick = (e) => { e.stopPropagation(); triggerRotate(-90); };
    $btnRotateRight.onclick = (e) => { e.stopPropagation(); triggerRotate(90); };
    
    $btn1to1.onclick = (e) => {
        e.stopPropagation();
        if (!$imgH.complete || $imgH.naturalWidth === 0) return;
        const containerW = $previewArea.clientWidth;
        const imgW = $imgH.naturalWidth;
        const targetScale = (imgW / window.devicePixelRatio) / containerW;
        scale = targetScale;
        pX = 0; pY = 0;
        updateTransform();
        showToolbar();
    };

    const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const newScale = Math.max(0.1, Math.min(5, scale + delta));
        if (newScale !== scale) {
            const rect = $previewArea.getBoundingClientRect();
            const mx = e.clientX - rect.left - rect.width / 2;
            const my = e.clientY - rect.top - rect.height / 2;
            pX -= (mx - pX) * (newScale / scale - 1);
            pY -= (my - pY) * (newScale / scale - 1);
            scale = newScale;
            if (scale <= 1) { pX = 0; pY = 0; }
            updateTransform();
            showToolbar();
        }
    };

    const onMouseDown = (e: MouseEvent) => {
        if (scale > 1 && e.button === 0) {
            isDragging = true;
            startX = e.clientX - pX;
            startY = e.clientY - pY;
            $previewArea.style.cursor = 'grabbing';
            e.preventDefault();
        }
    };

    const onMouseMove = (e: MouseEvent) => {
        if (isDragging && scale > 1) {
            pX = e.clientX - startX;
            pY = e.clientY - startY;
            updateTransform();
            showToolbar();
        } else {
            const rect = $previewArea.getBoundingClientRect();
            const isBottom = e.clientY > (rect.bottom - 80);
            const isToolbar = $zoomToolbar.contains(e.target as Node);
            if (isBottom || isToolbar) {
                showToolbar();
                if (isToolbar) {
                    $zoomToolbar.style.opacity = '1';
                    if (zoomTimer) clearTimeout(zoomTimer);
                }
            }
        }
    };

    const onMouseUp = () => {
        if (isDragging) {
            isDragging = false;
            updateTransform();
        }
    };

    const resetView = () => {
        scale = 1;
        pX = 0;
        pY = 0;
        updateTransform();
        showToolbar();
    };

    $previewArea.addEventListener('wheel', onWheel);
    $previewArea.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    loadImages();
    updateTransform(true, true);

    window.app.rotateLeft = () => triggerRotate(-90);
    window.app.rotateRight = () => triggerRotate(90);
    window.app.resetLoupeView = () => resetView();
    window.app.setViewTransform = (r: number, s: number, pl: number, pt: number) => {
        rotation = r; scale = s;
        pX = pl * $previewArea.clientWidth;
        pY = pt * $previewArea.clientHeight;
        updateTransform(true, true);
    };

    return {
        updateProps: (newProps: LoupeViewProps) => {
            props = newProps;
            if (rotation !== props.rotation) {
                rotation = props.rotation;
                updateTransform(true, true);
            }
        },
        destroy: () => {
            $previewArea.removeEventListener('wheel', onWheel);
            $previewArea.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            if (zoomTimer) clearTimeout(zoomTimer);
            if (savePrefsTimer) clearTimeout(savePrefsTimer);
        }
    };
}

