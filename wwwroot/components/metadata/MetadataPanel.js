import { h } from '../../snabbdom-setup.js';
import { ApertureVisualizer } from '../aperature/ApertureVisualizer.js';
export function MetadataPanel(props) {
    const { photo, metadata, cameraThumbUrl, onSearch } = props;
    if (!photo)
        return h('div.metadata-panel', 'No photo selected');
    const priorityTags = ['Exposure Time', 'Shutter Speed Value', 'F-Number', 'Aperture Value', 'Max Aperture Value', 'ISO Speed Rating', 'ISO', 'Focal Length', 'Focal Length 35', 'Lens Model', 'Lens', 'Model', 'Make', 'Exposure Bias Value', 'Exposure Mode', 'Exposure Program', 'Focus Mode', 'Image Stabilisation', 'Metering Mode', 'White Balance', 'Flash', 'Color Temperature', 'Quality', 'Created', 'Size', 'Image Width', 'Image Height', 'Exif Image Width', 'Exif Image Height', 'Software', 'Orientation', 'ID'];
    const groupOrder = ['File Info', 'Exif SubIF', 'Exif IFD0', 'Sony Maker', 'GPS', 'XMP'];
    const groups = {};
    metadata.forEach(m => {
        const k = m.directory || 'Unknown';
        if (!groups[k])
            groups[k] = [];
        groups[k].push(m);
    });
    // Ensure File Info exists
    if (!groups['File Info'])
        groups['File Info'] = [];
    const fileInfo = groups['File Info'];
    if (!fileInfo.find(m => m.tag === 'Created')) {
        fileInfo.push({ directory: 'File Info', tag: 'Created', value: new Date(photo.createdAt).toLocaleString() });
        fileInfo.push({ directory: 'File Info', tag: 'Size', value: (photo.size / (1024 * 1024)).toFixed(2) + ' MB' });
        fileInfo.push({ directory: 'File Info', tag: 'ID', value: photo.id });
    }
    const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
        const getMinPriority = (g) => {
            const priorities = groups[g].map(i => priorityTags.indexOf(i.tag)).filter(p => p !== -1);
            return priorities.length > 0 ? Math.min(...priorities) : 999;
        };
        const pa = getMinPriority(a);
        const pb = getMinPriority(b);
        if (pa !== pb)
            return pa - pb;
        let ia = groupOrder.indexOf(a);
        let ib = groupOrder.indexOf(b);
        if (ia === -1)
            ia = 999;
        if (ib === -1)
            ib = 999;
        return ia - ib;
    });
    const pickText = photo.isPicked ? '\u2691' : '';
    const starsText = photo.rating > 0 ? '\u2605'.repeat(photo.rating) : '';
    const hasAperture = metadata.some(m => m.tag === 'F-Number' || m.tag === 'Aperture Value');
    const hasFocal = metadata.some(m => m.tag === 'Focal Length');
    return h('div.metadata-panel', {
        style: { height: '100%', overflowY: 'auto', boxSizing: 'border-box' }
    }, [
        h('h2', `${photo.fileName} ${pickText} ${starsText}`),
        (hasAperture && hasFocal) ? ApertureVisualizer({ metadata: metadata, cameraThumbUrl }) : null,
        ...sortedGroupKeys.map(groupName => {
            const items = groups[groupName];
            items.sort((a, b) => {
                let ia = priorityTags.indexOf(a.tag);
                let ib = priorityTags.indexOf(b.tag);
                if (ia === -1)
                    ia = 999;
                if (ib === -1)
                    ib = 999;
                if (ia !== ib)
                    return ia - ib;
                return a.tag.localeCompare(b.tag);
            });
            return h('div.meta-group', [
                h('h3', groupName),
                ...items.map(m => h('div.meta-row', [
                    h('span.meta-key', m.tag || ''),
                    h('span.meta-val', m.value?.toString() || ''),
                    h('span.meta-search-btn', {
                        attrs: { title: 'Search' },
                        on: { click: () => onSearch(m.tag, m.value?.toString() || '') }
                    }, '\uD83D\uDD0D')
                ]))
            ]);
        })
    ]);
}
