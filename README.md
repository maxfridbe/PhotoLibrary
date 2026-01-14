# PhotoLibrary

A high-performance C# application designed to scan photo directories, index metadata, and host a web-based "Lightroom-style" viewer. Specifically optimized for slow network drives (CIFS/SMB) and massive libraries.

![Grid View](gridview.png)
![Loupe View](loupview.png)
![Library Maintenance](library.png)

## Features

-   **Efficient Network Scanning**: Reads only the first 1MB of each file to extract headers/metadata, significantly improving performance on high-latency mounts.
-   **Smart Stacking (UI-Driven)**: 
    *   Automatically groups JPG + RAW (ARW/NEF/CR2/DNG/etc.) pairs with identical names in the same folder.
    *   **Prioritized Display**: RAW files are shown as the stack representative by default.
    *   **Batch Actions**: Flagging or rating a stack representative automatically applies the action to all files in the group.
    *   **Visual Indicators**: Grouped items show a layered card effect and a count badge (e.g., `(2)`).
-   **Professional Fullscreen & Loupe Viewers**:
    *   **Persistent View State**: Remembers zoom, pan, and rotation for each image, restoring it exactly when you return.
    *   **Smart Zoom**: Zooms towards the cursor position. Automatically loads full-resolution original image when zooming past 150%.
    *   **Pixel-Perfect 1:1**: "1:1" button appears when full-res is loaded to zoom to exact device pixels (retina-aware).
    *   **Rotation**: Rotate images 90° with `[` and `]`, fully synced between Loupe, Grid, and Filmstrip views.
    *   **Staged Loading**: Both viewers use staged loading (300px -> 1024px -> Full-Res) with smooth CSS transitions to provide instant feedback even on slow connections.
    *   **Persistent Caching**: Previously loaded previews and full-res renders are cached in memory for the duration of the session, making back-and-forth navigation instantaneous.
-   **Library Maintenance Mode**:
    *   **Find New Images**: Scans your directories and identifies files not yet in the database.
    *   **Targeted Batch Import**: Efficiently index only the specific files found during search, rather than re-scanning entire trees.
    *   **Folder-Level Actions**: Right-click any folder in the tree to trigger "Generate Thumbnails" (Recursive or single-folder).
    *   **Live Progress**: Real-time progress bars for background thumbnail generation directly in the folder tree.
    *   **Smart Indexing**: Automatically skips unmodified, already-indexed files based on timestamp checks.
    *   **Robust Hashing**: Uses xxHash64 for ultra-fast, consistent file identification and duplicate detection.
    *   **Robust Normalization**: Automatically merges overlapping directory structures and deduplicates files recursively.
    *   **On-the-Fly Previews**: Live generation and caching of missing thumbnails and previews during browsing.
    *   **Database Stats**: Real-time tracking of image counts and database file sizes.
-   **High-Performance Web Interface**:
    *   **Virtualized Grid**: Custom rendering engine that handles hundreds of thousands of images.
    *   **20+ VS Code Themes**: Dynamic theming with popular palettes (One Dark Pro, Dracula, Nord, etc.).
    *   **Global Toast Notifications**: Real-time feedback for indexing progress and user actions.
    *   **Customizable Overlays**: Configurable Loupe view overlay with support for any metadata variable (e.g., `{Filename}`, `{MD:Lens Model}`).
-   **Aperture & Lens Visualization**: 
    *   **Dynamic SVG Render**: Generates a real-time visualization of the aperture blades and field-of-view cone based on EXIF data.
    *   **Sensor-Aware**: Automatically detects and displays sensor sizes (Full Frame, APS-C, 1/2.7", etc.) using focal plane resolution and crop factor calculations.
    *   **Live Metadata Readout**: Displays f-stop, focal length, ISO, and shutter speed in a sleek, integrated dashboard at the top of the metadata panel.
-   **Robust Backend & Architecture**:
    *   **Decoupled PubSub**: Frontend uses a type-safe, constant-driven event bus for seamless communication between components.
    *   **Container-Aware Fitting**: Rotated images automatically adapt their dimensions to fit their containers perfectly, preventing cropping in all view modes.
    *   **Stable Cycle-Safe Hierarchy**: Robust path reconstruction with automatic loop detection and hierarchy normalization.
    *   **Automatic Configuration**: Zero-config startup with `~/.config/PhotoLibrary/config.json`.
    *   **Binary WebSocket Streaming**: Optimized binary protocol for high-speed image delivery.
-   **Stability & Feedback**:
    *   **Connection Tracking**: Status bar shows exact offline duration (e.g., `Disconnected (45s ago)`) during network interruptions.
    *   **Graceful Shutdown**: Responds instantly to `Ctrl+C` via integrated cancellation tokens.

## Usage

### Quick Start (Zero Config)
The simplest way to use PhotoLibrary is to build the self-contained executable and run it. By default, it will store all its data and configuration in `~/.config/PhotoLibrary/`.

1.  **Build**: `./publish.sh`
2.  **Run**: `./dist/linux/PhotoLibrary`
3.  **Browse**: Open `http://localhost:8080` in your browser.
4.  **Import**: Use the "Maintenance" tab in the UI to add your photo directories.

### Manual Configuration
You can override any setting via CLI. These overrides are automatically saved to `~/.config/PhotoLibrary/config.json` for future runs.

```bash
# Example: Using custom database paths and port
./dist/linux/PhotoLibrary --library ~/my_photos.db --host 9090
```

### CLI Options
-   `--library <path>`: Path to the metadata SQLite database.
-   `--previewdb <path>`: Path to the previews SQLite database.
-   `--host <port>`: Port to host the web viewer on.
-   `--updatemd <dir>`: Directory to scan for images (legacy CLI-only import).
-   `--updatepreviews`: Enable preview generation during CLI scan.
-   `--longedge <pixels>`: Target size for previews (e.g., `--longedge 1024 --longedge 300`).

### Shortcuts
-   **'G'**: Grid View
-   **'L' / 'Enter' / 'Space'**: Loupe View (requires a selected image)
-   **'F'**: Toggle Fullscreen High-Res View
-   **'M'**: Toggle Metadata Panel (Right)
-   **'B'**: Toggle Library Panel (Left)
-   **'P'**: Toggle Flag (Pick) - applies to full stack if enabled
-   **'1' - '5'**: Set Star Rating - applies to full stack if enabled
-   **'0'**: Clear Star Rating
-   **'?'**: Show Shortcuts Dialog
-   **Arrows**: Navigate Grid/Filmstrip/Fullscreen

### Development Helpers
-   `./test.sh`: Samples 100 real images from RAID, preserving folder structure, and generates test DBs.
-   `./testhost.sh`: Launches the web viewer (port 8080) using test data.
-   `./run.sh`: Runs the application directly via `dotnet run`.


## Database Schema

-   **RootPaths**: Recursive folder hierarchy.
-   **FileEntry**: Core file records (Keyed by ID, includes xxHash64).
-   **Metadata**: Key-Value pairs for all photo data (Exif, XMP, etc.).
-   **images_picked / ImageRatings**: User culling data.
-   **UserCollections / CollectionFiles**: Custom user grouping logic.
-   **Previews**: Binary JPG blobs stored in a separate `previews.db` (Keyed by Hash + Size).
