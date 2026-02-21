/** @jsx jsx */
import { jsx, VNode } from '../../snabbdom-setup.js';
import * as Res from '../../Responses.generated.js';
import { hub } from '../../PubSub.js';
import { constants } from '../../constants.js';
import { server } from '../../CommunicationManager.js';

declare const maplibregl: any;

export class MapView {
    private map: any;
    private photos: Res.MapPhotoResponse[] = [];
    private selectedId: string | null = null;
    private markers: Map<string, any> = new Map();
    private $mapContainer: HTMLElement | null = null;

    constructor(private photoMap: Map<string, Res.PhotoResponse>) {
        hub.sub(constants.pubsub.UI_LAYOUT_CHANGED, () => {
            this.resize();
            this.applyTheme();
        });
    }

    public applyTheme() {
        if (!this.map || !this.map.loaded()) return;

        const style = getComputedStyle(document.documentElement);
        const bgPanel = style.getPropertyValue('--bg-panel').trim() || '#f0f0f0';
        const bgDark = style.getPropertyValue('--bg-dark').trim() || '#111';
        const accent = style.getPropertyValue('--accent').trim() || '#0078d7';
        const textMain = style.getPropertyValue('--text-main').trim() || '#ddd';
        const textMuted = style.getPropertyValue('--text-muted').trim() || '#888';

        try {
            if (this.map.getLayer('background')) {
                this.map.setPaintProperty('background', 'background-color', bgPanel);
            }
            if (this.map.getLayer('land-fill')) {
                this.map.setPaintProperty('land-fill', 'background-color', bgPanel);
            }
            if (this.map.getLayer('water')) {
                this.map.setPaintProperty('water', 'fill-color', bgDark);
            }
            if (this.map.getLayer('water-outline')) {
                this.map.setPaintProperty('water-outline', 'line-color', accent);
            }
            if (this.map.getLayer('admin-country')) {
                this.map.setPaintProperty('admin-country', 'line-color', accent);
            }
            if (this.map.getLayer('admin-state')) {
                this.map.setPaintProperty('admin-state', 'line-color', textMuted);
            }
            if (this.map.getLayer('country-labels')) {
                this.map.setPaintProperty('country-labels', 'text-color', textMuted);
                this.map.setPaintProperty('country-labels', 'text-halo-color', bgPanel);
            }
            if (this.map.getLayer('place-labels')) {
                this.map.setPaintProperty('place-labels', 'text-color', textMain);
                this.map.setPaintProperty('place-labels', 'text-halo-color', bgPanel);
            }
            
            // Update marker colors if any
            this.markers.forEach((marker, id) => {
                const el = marker.getElement();
                if (el) {
                    el.style.backgroundColor = accent;
                }
            });
        } catch (e) {
            console.warn('[MapView] Failed to update theme properties', e);
        }
    }

    public lazyLoadImage(id: string, img: HTMLImageElement, size: number) {
        const imageUrlCache = (window as any).app.imageUrlCache;
        const cacheKey = `${id}-${size}`;
        if (imageUrlCache.has(cacheKey)) {
            img.src = imageUrlCache.get(cacheKey)!;
            img.parentElement?.classList.add('loaded');
            return;
        }

        const priority = 5; // Medium priority for map view
        server.requestImage(id, size, priority).then(blob => {
            const url = URL.createObjectURL(blob);
            imageUrlCache.set(cacheKey, url);
            img.src = url;
            img.parentElement?.classList.add('loaded');
        }).catch(err => {
            console.error(`[MapView] Failed to load image ${id}`, err);
        });
    }

    public setPhotos(photos: Res.MapPhotoResponse[]) {
        this.photos = photos;
        this.updateMarkers();
    }

    public resize() {
        if (this.map) {
            this.map.resize();
        }
    }

    public setSelected(id: string | null) {
        this.selectedId = id;
        if (id && this.map) {
            const marker = this.markers.get(id);
            if (marker) {
                const lngLat = marker.getLngLat();
                this.map.flyTo({ center: lngLat, zoom: Math.max(this.map.getZoom(), 10) });
            }
        }
    }

    public ensureMap() {
        if (this.map) return;
        const el = document.getElementById('map-container-el');
        if (el) {
            this.init(el);
        } else {
            console.log('[MapView] map-container-el not found in DOM yet.');
        }
    }

    public init(container: HTMLElement) {
        console.log('[MapView] init() called with container:', container.id, 'Size:', container.clientWidth, 'x', container.clientHeight);
        this.$mapContainer = container;
        if (this.map) {
            console.log('[MapView] Map already exists, resizing');
            this.map.resize();
            return;
        }

        if (typeof maplibregl === 'undefined') {
            console.error('[MapView] maplibregl is NOT defined! Check if script is loaded.');
            return;
        }

        console.log('[MapView] Creating new MapLibre instance...');
        try {
            const cssStyle = getComputedStyle(document.documentElement);
            const bgPanel = cssStyle.getPropertyValue('--bg-panel').trim() || '#f0f0f0';
            const bgDark = cssStyle.getPropertyValue('--bg-dark').trim() || '#111';
            const accent = cssStyle.getPropertyValue('--accent').trim() || '#0078d7';
            const textMain = cssStyle.getPropertyValue('--text-main').trim() || '#ddd';
            const textMuted = cssStyle.getPropertyValue('--text-muted').trim() || '#888';

            this.map = new maplibregl.Map({
                container: container,
                style: {
                    version: 8,
                    sources: {
                        'naturalearth': {
                            type: 'vector',
                            tiles: [window.location.origin + '/tiles/{z}/{x}/{y}.pbf'],
                            minzoom: 0,
                            maxzoom: 7
                        }
                    },
                    layers: [
                        {
                            id: 'background',
                            type: 'background',
                            paint: { 'background-color': bgPanel }
                        },
                        {
                            id: 'land-fill',
                            type: 'background',
                            paint: { 'background-color': bgPanel }
                        },
                        {
                            id: 'water',
                            type: 'fill',
                            source: 'naturalearth',
                            'source-layer': 'water',
                            paint: { 'fill-color': bgDark }
                        },
                        {
                            id: 'water-outline',
                            type: 'line',
                            source: 'naturalearth',
                            'source-layer': 'water',
                            paint: { 
                                'line-color': accent,
                                'line-width': 1
                            }
                        },
                        {
                            id: 'admin-country',
                            type: 'line',
                            source: 'naturalearth',
                            'source-layer': 'admin',
                            filter: ['all', ['<=', 'admin_level', 2]],
                            paint: { 
                                'line-color': accent, 
                                'line-width': 1.2
                            }
                        },
                        {
                            id: 'admin-state',
                            type: 'line',
                            source: 'naturalearth',
                            'source-layer': 'admin',
                            filter: ['all', ['>', 'admin_level', 2]],
                            paint: { 
                                'line-color': textMuted, 
                                'line-width': 0.6,
                                'line-dasharray': [2, 1]
                            }
                        },
                        {
                            id: 'country-labels',
                            type: 'symbol',
                            source: 'naturalearth',
                            'source-layer': 'country_label',
                            layout: {
                                'text-field': '{name}',
                                'text-size': 12,
                                'text-transform': 'uppercase'
                            },
                            paint: { 
                                'text-color': textMuted,
                                'text-halo-color': bgPanel,
                                'text-halo-width': 1
                            }
                        },
                        {
                            id: 'place-labels',
                            type: 'symbol',
                            source: 'naturalearth',
                            'source-layer': 'place_label',
                            layout: {
                                'text-field': '{name}',
                                'text-size': 11
                            },
                            paint: { 
                                'text-color': textMain,
                                'text-halo-color': bgPanel,
                                'text-halo-width': 1
                            }
                        }
                    ]
                },
                center: [0, 20],
                zoom: 1.5
            });

            this.map.on('load', () => {
                console.log('[MapView] Map "load" event fired.');
                
                // Log all layers and their paint properties
                const layers = this.map.getStyle().layers;
                console.log('[MapView] Current Map Layers and Paint Properties:');
                layers.forEach((layer: any) => {
                    console.log(`Layer: ${layer.id}`, layer.paint || {});
                });

                this.updateMarkers();
            });

            // If photos were already set, try updating markers immediately as well
            if (this.photos.length > 0) {
                this.updateMarkers();
            }

            this.map.on('error', (e: any) => {
                console.error('[MapView] Map error:', e);
            });
        } catch (err) {
            console.error('[MapView] Failed to create MapLibre instance:', err);
        }
    }

    private updateMarkers() {
        console.log(`[MapView] updateMarkers() called. Map exists: ${!!this.map}, Photos: ${this.photos.length}`);
        if (!this.map) return;

        // Clear existing markers
        this.markers.forEach(m => m.remove());
        this.markers.clear();

        const style = getComputedStyle(document.documentElement);
        const accent = style.getPropertyValue('--accent').trim() || '#0078d7';

        this.photos.forEach(photo => {
            const el = document.createElement('div');
            el.className = 'marker';
            el.style.backgroundColor = accent;
            el.style.width = '12px';
            el.style.height = '12px';
            el.style.borderRadius = '50%';
            el.style.border = '2px solid white';
            el.style.cursor = 'pointer';
            el.style.boxShadow = '0 0 5px rgba(0,0,0,0.5)';

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const fullPhoto = this.photoMap.get(photo.fileEntryId);
                if (fullPhoto) {
                    hub.pub(constants.pubsub.PHOTO_SELECTED, { 
                        fileEntryId: photo.fileEntryId, 
                        photo: fullPhoto,
                        modifiers: { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }
                    });
                }
            });

            try {
                const marker = new maplibregl.Marker({ element: el })
                    .setLngLat([photo.longitude, photo.latitude])
                    .addTo(this.map);
                
                this.markers.set(photo.fileEntryId, marker);
            } catch (err) {
                console.error(`[MapView] Failed to add marker for photo ${photo.fileEntryId}:`, err);
            }
        });
        console.log(`[MapView] Added ${this.markers.size} markers.`);
    }

    public render(): VNode {
        return (
            <div id="map-container-el" style={{ width: '100%', height: '100%', position: 'relative', background: '#333' }} 
                 hook={{
                     destroy: () => { 
                         console.log('[MapView] map-container-el destroy hook');
                         if(this.map) { this.map.remove(); this.map = null; } 
                     }
                 }}>
            </div>
        );
    }
}
