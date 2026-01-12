# PhotoLibrary

A high-performance C# application designed to scan photo directories, index metadata, and host a web-based "Lightroom-style" viewer. Specifically optimized for slow network drives (CIFS/SMB) and massive libraries.

## Features

-   **Efficient Network Scanning**: Reads only the first 1MB of each file to extract headers/metadata, significantly improving performance on high-latency mounts.
-   **Smart Stacking (UI-Driven)**: 
    *   Automatically groups JPG + RAW (ARW) pairs with identical names in the same folder.
    *   **Prioritized Display**: RAW files are shown as the stack representative by default.
    *   **Batch Actions**: Flagging or rating a stack representative automatically applies the action to all files in the group.
    *   **Visual Indicators**: Grouped items show a layered card effect and a count badge (e.g., `(2)`).
-   **Professional Fullscreen & Loupe Viewers**:
    *   **Staged Loading**: Both viewers use staged loading (300px -> 1024px -> Full-Res) with smooth CSS transitions to provide instant feedback even on slow connections.
    *   **Persistent Caching**: Previously loaded previews and full-res renders are cached in memory for the duration of the session, making back-and-forth navigation instantaneous.
-   **Library Maintenance Mode**:
    *   **Find New Images**: Scans your directories and identifies files not yet in the database.
    *   **Targeted Batch Import**: Efficiently index only the specific files found during search, rather than re-scanning entire trees.
    *   **Smart Indexing**: Automatically skips unmodified, already-indexed files based on timestamp checks.
    *   **On-the-Fly Previews**: Live generation and caching of missing thumbnails and previews during browsing.
    *   **Database Stats**: Real-time tracking of image counts and database file sizes.
-   **High-Performance Web Interface**:
    *   **Virtualized Grid**: Custom rendering engine that handles hundreds of thousands of images.
    *   **20+ VS Code Themes**: Dynamic theming with popular palettes (One Dark Pro, Dracula, Nord, etc.).
    *   **Global Toast Notifications**: Real-time feedback for indexing progress and user actions.
    *   **Customizable Overlays**: Configurable Loupe view overlay with support for any metadata variable (e.g., `{Filename}`, `{MD:Lens Model}`).
-   **Stable Backend**:
    *   **Cycle-Safe Hierarchy**: Robust path reconstruction with automatic loop detection and hierarchy normalization.
    *   **Automatic Configuration**: Zero-config startup with `~/.config/PhotoLibrary/config.json`.
    *   **Binary WebSocket Streaming**: Optimized binary protocol for high-speed image delivery.
-   **Stability & Feedback**:
    *   **Connection Tracking**: Status bar shows exact offline duration (e.g., `Disconnected (45s ago)`) during network interruptions.
    *   **Graceful Shutdown**: Responds instantly to `Ctrl+C` via integrated cancellation tokens.

## Usage

### Prerequisites
- .NET 8.0 SDK
- TypeScript (`tsc`) for web asset compilation (handled automatically during `dotnet build`)

### Commands
```bash
./run.sh --library <path> --updatemd <dir> [OPTIONS]
```

#### Options
-   `--library <path>`: Path to the metadata SQLite database.
-   `--updatemd <path>`: Directory to scan for images.
-   `--updatepreviews`: Enable preview generation.
-   `--previewdb <path>`: Path to the previews SQLite database.
-   `--longedge <pixels>`: Target size for previews (e.g., `--longedge 1024 --longedge 300`).
-   `--host <port>`: Starts the web viewer on the specified port.

### Shortcuts
-   **'G'**: Grid View
-   **'L' / 'Enter' / 'Space'**: Loupe View (requires a selected image)
-   **'F'**: Toggle Fullscreen High-Res View
-   **'P'**: Toggle Flag (Pick) - applies to full stack if enabled
-   **'1' - '5'**: Set Star Rating - applies to full stack if enabled
-   **'0'**: Clear Star Rating
-   **'?'**: Show Shortcuts Dialog
-   **Arrows**: Navigate Grid/Filmstrip/Fullscreen

### Helper Scripts
-   `./test.sh`: Samples 100 real images from RAID, preserving folder structure, and generates test DBs.
-   `./testhost.sh`: Launches the web viewer (port 8080) using test data.
-   `./publish.sh`: Creates a self-contained, single-file executable in `./dist`.

## Database Schema

-   **RootPaths**: Recursive folder hierarchy.
-   **FileEntry**: Core file records.
-   **Metadata**: Key-Value pairs for all photo data (Exif, XMP, etc.).
-   **images_picked / ImageRatings**: User culling data.
-   **UserCollections / CollectionFiles**: Custom user grouping logic.
-   **Previews**: Binary JPG blobs stored in a separate `previews.db`.
