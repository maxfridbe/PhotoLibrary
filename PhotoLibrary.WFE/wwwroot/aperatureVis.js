/**
 * REQ-WFE-00005
 * Injects and visualizes lens data into a specific container.
 * @param metadata - The array of EXIF data tags.
 * @param containerId - The ID of the div to inject into.
 * @param cameraThumbUrl - Optional URL for the camera thumbnail.
 */
export function visualizeLensData(metadata, containerId, cameraThumbUrl) {
    // Generate a unique ID suffix to prevent SVG ID collisions
    const uid = Math.random().toString(36).substr(2, 9);
    // 1. Parsing Logic
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
    // Calculate Crop Factor
    let cropFactor = 1.0;
    if (focal35 && rawFocal) {
        cropFactor = focal35 / rawFocal;
    }
    else if (rawFocal) {
        // Try to calculate from Focal Plane Resolution
        const fx = parseNum(getVal("Exif SubIFD", "Focal Plane X Resolution"));
        const fy = parseNum(getVal("Exif SubIFD", "Focal Plane Y Resolution"));
        const unit = getVal("Exif SubIFD", "Focal Plane Resolution Unit");
        const imgW = parseNum(getVal("Exif SubIFD", "Exif Image Width")) || parseNum(getVal("JPEG", "Image Width"));
        const imgH = parseNum(getVal("Exif SubIFD", "Exif Image Height")) || parseNum(getVal("JPEG", "Image Height"));
        if (fx && imgW && fy && imgH) {
            // If resolution is small (like 13/128000), it's likely "Units per pixel"
            // If resolution is large (like 3000), it's likely "Pixels per unit"
            let sensorW = fx < 1 ? fx * imgW : imgW / fx;
            let sensorH = fy < 1 ? fy * imgH : imgH / fy;
            // Convert to mm if unit is Inches (2 or "Inches")
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
            // Default fallback
            if (rawFocal < 10) {
                cropFactor = 6.0; // Assume small sensor if very short real focal length
            }
            else {
                cropFactor = 1.5; // Default assumption for mirrorless/DSLR
            }
            focal35 = rawFocal * cropFactor;
        }
    }
    const fStop = parseNum(getVal("Exif SubIFD", "F-Number")) || 2.8;
    // Robust camera model detection
    let model = getVal("Exif IFD0", "Model");
    if (!model) {
        // Fallback: look for 'Model' or 'Camera Model Name' in any directory
        const modelItem = metadata.find(x => x.tag === "Model" || x.tag === "Camera Model Name");
        model = modelItem ? modelItem.value : "Unknown Camera";
    }
    const iso = getVal("Exif SubIFD", "ISO Speed Ratings") || "---";
    const shutterTime = getVal("Exif SubIFD", "Exposure Time") || "---";
    const explicitBlades = parseNum(getVal("MakerNotes", "Aperture Blades")) ||
        parseNum(getVal("Composite", "Aperture Blades"));
    const bladeCountVal = explicitBlades > 0 ? explicitBlades : 7; // Default 7
    // 2. Scale Logic (Pixels per MM)
    const pxPerMm = 4;
    let sensorW_mm = 36;
    let sensorH_mm = 24;
    let sensorName = "Full Frame";
    // Crop Detection
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
    // 3. Inject HTML
    const container = document.getElementById(containerId);
    if (!container)
        return;
    let visRoot = container.querySelector(":scope > .vis-root");
    if (!visRoot) {
        visRoot = document.createElement("div");
        visRoot.className = "vis-root";
        container.appendChild(visRoot);
    }
    // UPDATED: SVG width is now 100% and height auto to allow scaling into small containers
    // UPDATED: Padding reduced slightly to accommodate smaller sizes better
    visRoot.innerHTML = `
        <div style="width: 100%; text-align: center; background: #222; padding: 15px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); color: #e0e0e0; box-sizing: border-box;">
            <svg id="visualizer-${uid}" width="100%" height="100%" viewBox="0 0 300 300" style="display: block; margin: 0 auto; background: #2a2a2a; border-radius: 8px; box-shadow: inset 0 0 20px #000;">
                <defs>
                    <clipPath id="housing-clip-${uid}">
                        <circle cx="150" cy="150" r="100" />
                    </clipPath>
                </defs>
                
                <path id="fov-cone-${uid}" fill="rgba(255, 215, 0, 0.15)" stroke="rgba(255,215,0,0.3)" d="M150,150 L50,0 L250,0 Z" />
                <circle cx="150" cy="150" r="105" fill="#333" stroke="#555" stroke-width="2" />
                <circle cx="150" cy="150" r="100" fill="#181818" />
                <g id="aperture-blades-${uid}" clip-path="url(#housing-clip-${uid})"></g>
                <rect id="sensor-outline-${uid}" x="0" y="0" width="0" height="0" fill="rgba(255, 255, 255, 0.05)" stroke="#00bcd4" stroke-width="1.5" stroke-dasharray="4,3" />
                <text id="sensor-label-${uid}" x="150" y="150" text-anchor="middle" dominant-baseline="middle" fill="#00bcd4" font-size="10" style="pointer-events: none; opacity: 0.8; text-shadow: 0px 0px 3px #000; font-weight: bold;"></text>
                <text x="20" y="280" text-anchor="start" fill="#00bcd4" font-size="14" id="readout-${uid}">Loading...</text>
                <text x="280" y="280" text-anchor="end" fill="#ffd700" font-size="14" id="shutter-speed-${uid}" style="font-weight: bold; font-family: monospace;">--</text>
            </svg>
            <div id="details-container-${uid}" style="margin-top: 10px; display: flex; align-items: center; justify-content: center; gap: 15px;">
                <img id="camera-thumb-${uid}" style="display: none; width: 30%; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.5);">
                <div id="details-${uid}" style="text-align: left; font-family: monospace; color: #00bcd4; line-height: 1.5; font-size: 0.9em;"></div>
            </div>
        </div>
    `;
    // 4. Rendering Logic
    const bladeGroup = visRoot.querySelector(`#aperture-blades-${uid}`);
    const fovCone = visRoot.querySelector(`#fov-cone-${uid}`);
    const readout = visRoot.querySelector(`#readout-${uid}`);
    const shutterDisplay = visRoot.querySelector(`#shutter-speed-${uid}`);
    const details = visRoot.querySelector(`#details-${uid}`);
    const sensorRect = visRoot.querySelector(`#sensor-outline-${uid}`);
    const sensorLabel = visRoot.querySelector(`#sensor-label-${uid}`);
    const cameraThumb = visRoot.querySelector(`#camera-thumb-${uid}`);
    if (!bladeGroup || !fovCone || !readout || !shutterDisplay || !details || !sensorRect || !sensorLabel || !cameraThumb) {
        return;
    }
    // Update Camera Thumb
    if (cameraThumbUrl) {
        cameraThumb.src = cameraThumbUrl;
        cameraThumb.style.display = "block";
    }
    else {
        cameraThumb.style.display = "none";
    }
    // Update Text
    readout.textContent = `f/${fStop} @ ${rawFocal}mm`;
    shutterDisplay.textContent = shutterTime.toString();
    details.innerHTML = `${model}<br><small style="color: #888;">ISO ${iso} • ${sensorName} • ${bladeCountVal} Blades</small>`;
    // Update Sensor Rect
    const sW = sensorW_mm * pxPerMm;
    const sH = sensorH_mm * pxPerMm;
    sensorRect.setAttribute("width", sW.toString());
    sensorRect.setAttribute("height", sH.toString());
    sensorRect.setAttribute("x", (150 - sW / 2).toString());
    sensorRect.setAttribute("y", (150 - sH / 2).toString());
    sensorLabel.textContent = sensorName.toUpperCase();
    // Calculate Geometry
    const maxPhysicalRadius = 95;
    const openness = 0.95 / (fStop || 1);
    const holeRadius = Math.max(3, maxPhysicalRadius * openness);
    const coneWidth = 3000 / (focal35 || 50);
    const safeWidth = Math.min(coneWidth, 145);
    fovCone.setAttribute("d", `M150,150 L${150 - safeWidth},0 L${150 + safeWidth},0 Z`);
    // Draw Blades
    bladeGroup.innerHTML = "";
    const angleStep = (Math.PI * 2) / bladeCountVal;
    const rOuter = 160;
    const cx = 150;
    const cy = 150;
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
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M${x1},${y1} L${x2},${y2} L${x3},${y3} L${x4},${y4} Z`);
        path.setAttribute("fill", "#222");
        path.setAttribute("stroke", "#444");
        path.setAttribute("stroke-width", "1");
        bladeGroup.appendChild(path);
    }
}
