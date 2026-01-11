# PhotoLibrary

A high-performance C# application designed to scan photo directories, index metadata, and host a web-based "Lightroom-style" viewer. Specifically optimized for slow network drives (CIFS/SMB) and massive libraries.

## Features

-   **Efficient Network Scanning**: Reads only the first 1MB of each file to extract headers/metadata, significantly improving performance on high-latency mounts.
-   **Smart Stacking (UI-Driven)**: 
    *   Automatically groups JPG + RAW (ARW) pairs with identical names in the same folder.
    *   **Prioritized Display**: RAW files are shown as the stack representative by default.
    *   **Batch Actions**: Flagging or rating a stack representative automatically applies the action to all files in the group.
    *   **Visual Indicators**: Grouped items show a layered card effect and a count badge (e.g., `(2)`).
-   **Professional Fullscreen Viewer**:
    *   **Staged Loading**: Shows an immediate blurred placeholder (1024px) followed by a smooth fade-in of the full-resolution render.
    *   **On-Demand Rendering**: The backend renders high-quality JPEGs from RAW files instantly when requested.
    *   **Orientation Aware**: Automatically respects EXIF orientation metadata for all previews and renders.
    *   **Sticky Navigation**: Browse your entire library with arrow keys while remaining in fullscreen mode.
-   **High-Performance Web Interface**:
    *   **Virtualized Grid**: Custom rendering engine that handles hundreds of thousands of images by only rendering visible items.
    *   **Flicker-Free UI**: Surgical DOM updates and intelligent node recycling prevent visual flashes.
    *   **Tag Search**: Instant metadata search (e.g., search by Focal Length, Lens, or Filename).
    *   **Flexible Sorting**: Sort by Date, Name, Rating, or Size directly in the UI.
    *   **WebSocket Streaming**: Custom binary protocol for ultra-fast image delivery.
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
