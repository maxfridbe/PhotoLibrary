import { h } from '../../snabbdom-setup.js';
import { ApertureVisualizer } from '../aperature/ApertureVisualizer.js';
export function MetadataPanel(props) {
    const { photo, metadata, cameraThumbUrl, onSearch } = props;
    if (!photo)
        return h('div.metadata-panel', 'No photo selected');
    const priorityTags = ['Exposure Time', 'Shutter Speed Value', 'F-Number', 'Aperture Value', 'Max Aperture Value', 'ISO Speed Rating', 'ISO', 'Focal Length', 'Focal Length 35', 'Lens Model', 'Lens', 'Model', 'Make', 'Exposure Bias Value', 'Exposure Mode', 'Exposure Program', 'Focus Mode', 'Image Stabilisation', 'Metering Mode', 'White Balance', 'Flash', 'Color Temperature', 'Quality', 'Created', 'Size', 'Image Width', 'Image Height', 'Exif Image Width', 'Exif Image Height', 'Software', 'Orientation', 'ID'];
    const groupOrder = ['File Info', 'Exif SubIF', 'Exif IFD0', 'Sony Maker', 'GPS', 'XMP'];
    // Deep clone to avoid mutating the original metadata list from state
    const groups = metadata.map(g => ({ ...g, items: { ...g.items } }));
    // Ensure File Info exists and has required items
    let fileInfo = groups.find(g => g.name === 'File Info');
    if (!fileInfo) {
        fileInfo = { name: 'File Info', items: {} };
        groups.push(fileInfo);
    }
    if (!fileInfo.items['Created']) {
        fileInfo.items['Created'] = new Date(photo.createdAt).toLocaleString();
        fileInfo.items['Size'] = (photo.size / (1024 * 1024)).toFixed(2) + ' MB';
        fileInfo.items['ID'] = photo.id;
    }
    const sortedGroups = groups.sort((a, b) => {
        const getMinPriority = (g) => {
            const priorities = Object.keys(g.items).map(tag => priorityTags.indexOf(tag)).filter(p => p !== -1);
            return priorities.length > 0 ? Math.min(...priorities) : 999;
        };
        const pa = getMinPriority(a);
        const pb = getMinPriority(b);
        if (pa !== pb)
            return pa - pb;
        let ia = groupOrder.indexOf(a.name);
        let ib = groupOrder.indexOf(b.name);
        if (ia === -1)
            ia = 999;
        if (ib === -1)
            ib = 999;
        return ia - ib;
    });
    const pickText = photo.isPicked ? '\u2691' : '';
    const starsText = photo.rating > 0 ? '\u2605'.repeat(photo.rating) : '';
    const flatMetadataTags = metadata.flatMap(g => Object.keys(g.items));
    const hasAperture = flatMetadataTags.includes('F-Number') || flatMetadataTags.includes('Aperture Value');
    const hasFocal = flatMetadataTags.includes('Focal Length');
    return h('div.metadata-panel', {
        style: { height: '100%', overflowY: 'auto', boxSizing: 'border-box' }
    }, [
        h('h2', `${photo.fileName} ${pickText} ${starsText}`),
        (hasAperture && hasFocal) ? ApertureVisualizer({
            metadata: metadata.flatMap(g => Object.entries(g.items).map(([tag, value]) => ({ tag, value }))),
            cameraThumbUrl
        }) : null,
        ...sortedGroups.map(group => {
            const items = Object.entries(group.items);
            items.sort((a, b) => {
                let ia = priorityTags.indexOf(a[0]);
                let ib = priorityTags.indexOf(b[0]);
                if (ia === -1)
                    ia = 999;
                if (ib === -1)
                    ib = 999;
                if (ia !== ib)
                    return ia - ib;
                return a[0].localeCompare(b[0]);
            });
            return h('div.meta-group', [
                h('h3', group.name),
                ...items.map(([tag, value]) => h('div.meta-row', [
                    h('span.meta-key', tag),
                    h('span.meta-val', value?.toString() || ''),
                    h('span.meta-search-btn', {
                        attrs: { title: 'Search' },
                        on: { click: () => onSearch(tag, value?.toString() || '') }
                    }, '\uD83D\uDD0D')
                ]))
            ]);
        })
    ]);
}
