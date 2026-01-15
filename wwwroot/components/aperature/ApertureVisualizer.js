import { h } from '../../snabbdom-setup.js';
export function ApertureVisualizer(data) {
    const { metadata, cameraThumbUrl } = data;
    const getVal = (dir, tag) => {
        const item = metadata.find((x) => x.directory === dir && x.tag === tag);
        return item ? item.value : null;
    };
    const parseNum = (input) => {
        if (input === null || input === undefined)
            return 0;
        const str = input.toString().trim();
        if (str.includes("/")) {
            const parts = str.split("/");
            const num = parseFloat(parts[0]);
            const den = parseFloat(parts[1].split(" ")[0]);
            if (!isNaN(num) && !isNaN(den) && den !== 0)
                return num / den;
        }
        const result = parseFloat(str.replace(/[^\d\.]/g, ""));
        return isNaN(result) ? 0 : result;
    };
    const rawFocal = parseNum(getVal("Exif SubIFD", "Focal Length"));
    let focal35 = parseNum(getVal("Exif SubIFD", "Focal Length 35")) ||
        parseNum(getVal("Exif SubIFD", "Focal Length In 35mm Film"));
    let cropFactor = 1.0;
    if (focal35 && rawFocal) {
        cropFactor = focal35 / rawFocal;
    }
    else if (rawFocal) {
        const fx = parseNum(getVal("Exif SubIFD", "Focal Plane X Resolution"));
        const fy = parseNum(getVal("Exif SubIFD", "Focal Plane Y Resolution"));
        const unit = getVal("Exif SubIFD", "Focal Plane Resolution Unit");
        const imgW = parseNum(getVal("Exif SubIFD", "Exif Image Width")) || parseNum(getVal("JPEG", "Image Width"));
        const imgH = parseNum(getVal("Exif SubIFD", "Exif Image Height")) || parseNum(getVal("JPEG", "Image Height"));
        if (fx && imgW && fy && imgH) {
            let sensorW = fx < 1 ? fx * imgW : imgW / fx;
            let sensorH = fy < 1 ? fy * imgH : imgH / fy;
            if (unit === 2 || (unit && unit.toString().toLowerCase().includes("inch"))) {
                sensorW *= 25.4;
                sensorH *= 25.4;
            }
            const sensorDiag = Math.sqrt(sensorW * sensorW + sensorH * sensorH);
            const fullFrameDiag = Math.sqrt(36 * 36 + 24 * 24);
            cropFactor = fullFrameDiag / sensorDiag;
            focal35 = rawFocal * cropFactor;
        }
        else {
            if (rawFocal < 10)
                cropFactor = 6.0;
            else
                cropFactor = 1.5;
            focal35 = rawFocal * cropFactor;
        }
    }
    const fStop = parseNum(getVal("Exif SubIFD", "F-Number")) || 2.8;
    const model = getVal("Exif IFD0", "Model") || "Unknown Camera";
    const iso = getVal("Exif SubIFD", "ISO Speed Ratings") || "---";
    const shutterTime = getVal("Exif SubIFD", "Exposure Time") || "---";
    const explicitBlades = parseNum(getVal("MakerNotes", "Aperture Blades")) ||
        parseNum(getVal("Composite", "Aperture Blades"));
    const bladeCountVal = explicitBlades > 0 ? explicitBlades : 7;
    const pxPerMm = 4;
    let sensorW_mm = 36;
    let sensorH_mm = 24;
    let sensorName = "Full Frame";
    if (cropFactor >= 6.0) {
        sensorName = "1/2.7\" Small Sensor";
        sensorW_mm = 5.37;
        sensorH_mm = 4.04;
    }
    else if (cropFactor >= 5.0) {
        sensorName = "1/2.3\" Small Sensor";
        sensorW_mm = 6.17;
        sensorH_mm = 4.55;
    }
    else if (cropFactor >= 4.0) {
        sensorName = "1/1.7\" Point & Shoot";
        sensorW_mm = 7.6;
        sensorH_mm = 5.7;
    }
    else if (cropFactor >= 2.6) {
        sensorName = '1" / CX';
        sensorW_mm = 13.2;
        sensorH_mm = 8.8;
    }
    else if (cropFactor >= 1.9) {
        sensorName = "Micro 4/3";
        sensorW_mm = 17.3;
        sensorH_mm = 13;
    }
    else if (cropFactor >= 1.6) {
        sensorName = "APS-C (Canon)";
        sensorW_mm = 22.3;
        sensorH_mm = 14.9;
    }
    else if (cropFactor >= 1.3) {
        sensorName = "APS-C / DX";
        sensorW_mm = 23.6;
        sensorH_mm = 15.6;
    }
    else if (cropFactor <= 1.1) {
        sensorName = "Full Frame";
        sensorW_mm = 36;
        sensorH_mm = 24;
    }
    const sW = sensorW_mm * pxPerMm;
    const sH = sensorH_mm * pxPerMm;
    const maxPhysicalRadius = 95;
    const openness = 0.95 / (fStop || 1);
    const holeRadius = Math.max(3, maxPhysicalRadius * openness);
    const coneWidth = 3000 / (focal35 || 50);
    const safeWidth = Math.min(coneWidth, 145);
    const angleStep = (Math.PI * 2) / bladeCountVal;
    const rOuter = 160;
    const cx = 150;
    const cy = 150;
    const bladePaths = [];
    for (let i = 0; i < bladeCountVal; i++) {
        const theta = i * angleStep;
        const nextTheta = (i + 1) * angleStep;
        const x1 = cx + holeRadius * Math.cos(theta);
        const y1 = cy + holeRadius * Math.sin(theta);
        const x2 = cx + holeRadius * Math.cos(nextTheta);
        const y2 = cy + holeRadius * Math.sin(nextTheta);
        const x3 = cx + rOuter * Math.cos(nextTheta + 0.3);
        const y3 = cy + rOuter * Math.sin(nextTheta + 0.3);
        const x4 = cx + rOuter * Math.cos(theta + 0.3);
        const y4 = cy + rOuter * Math.sin(theta + 0.3);
        bladePaths.push(h('path', {
            attrs: {
                d: `M${x1},${y1} L${x2},${y2} L${x3},${y3} L${x4},${y4} Z`,
                fill: "#222",
                stroke: "#444",
                'stroke-width': "1"
            }
        }));
    }
    return h('div.vis-root', [
        h('div', {
            style: {
                width: '100%', textAlign: 'center', background: '#222',
                padding: '15px', borderRadius: '12px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                color: '#e0e0e0', boxSizing: 'border-box'
            }
        }, [
            h('svg', {
                attrs: { width: "100%", height: "100%", viewBox: "0 0 300 300" },
                style: { display: 'block', margin: '0 auto', background: '#2a2a2a', borderRadius: '8px', boxShadow: 'inset 0 0 20px #000' }
            }, [
                h('defs', [
                    h('clipPath', { attrs: { id: 'housing-clip' } }, [
                        h('circle', { attrs: { cx: "150", cy: "150", r: "100" } })
                    ])
                ]),
                h('path', {
                    attrs: {
                        id: 'fov-cone', fill: "rgba(255, 215, 0, 0.15)", stroke: "rgba(255,215,0,0.3)",
                        d: `M150,150 L${150 - safeWidth},0 L${150 + safeWidth},0 Z`
                    }
                }),
                h('circle', { attrs: { cx: "150", cy: "150", r: "105", fill: "#333", stroke: "#555", 'stroke-width': "2" } }),
                h('circle', { attrs: { cx: "150", cy: "150", r: "100", fill: "#181818" } }),
                h('g', { attrs: { 'clip-path': "url(#housing-clip)" } }, bladePaths),
                h('rect', {
                    attrs: {
                        x: (150 - sW / 2).toString(), y: (150 - sH / 2).toString(),
                        width: sW.toString(), height: sH.toString(),
                        fill: "rgba(255, 255, 255, 0.05)", stroke: "#00bcd4", 'stroke-width': "1.5", 'stroke-dasharray': "4,3"
                    }
                }),
                h('text', {
                    attrs: { x: "150", y: "150", 'text-anchor': "middle", 'dominant-baseline': "middle", fill: "#00bcd4", 'font-size': "10" },
                    style: { pointerEvents: 'none', opacity: '0.8', textShadow: '0px 0px 3px #000', fontWeight: 'bold' }
                }, sensorName.toUpperCase()),
                h('text', { attrs: { x: "20", y: "280", 'text-anchor': "start", fill: "#00bcd4", 'font-size': "14" } }, `f/${fStop} @ ${rawFocal}mm`),
                h('text', {
                    attrs: { x: "280", y: "280", 'text-anchor': "end", fill: "#ffd700", 'font-size': "14" },
                    style: { fontWeight: 'bold', fontFamily: 'monospace' }
                }, shutterTime.toString()),
            ]),
            h('div', {
                style: { marginTop: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '15px' }
            }, [
                cameraThumbUrl ? h('img', {
                    attrs: { src: cameraThumbUrl },
                    style: { width: '30%', height: 'auto', borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }
                }) : null,
                h('div', {
                    style: { textAlign: 'left', fontFamily: 'monospace', color: '#00bcd4', lineHeight: '1.5', fontSize: '0.9em' },
                    props: { innerHTML: `${model}<br><small style="color: #888;">ISO ${iso} • ${sensorName} • ${bladeCountVal} Blades</small>` }
                })
            ])
        ])
    ]);
}
