# PhotoLibrary

A high-performance C# CLI application designed to scan photo directories, index metadata, and host a web-based "Lightroom-style" viewer. It is specifically optimized for slow network drives (CIFS/SMB) and large photo libraries.

## Features

-   **Efficient Network Scanning**: Reads only the first 1MB of each file to extract headers/metadata, significantly improving performance on high-latency mounts.
-   **Web Interface (viewer)**:
    -   **Grid View**: Fast thumbnail grid with lazy loading.
    -   **Loupe View**: High-resolution preview with a filmstrip for quick navigation.
    -   **Metadata Sidebar**: Resizable panel showing detailed Exif, XMP, and system metadata.
    -   **WebSocket Delivery**: Uses a custom binary WebSocket protocol for ultra-efficient image streaming.
-   **Preview System**: 
    -   Generates resized JPG previews stored in a separate SQLite database.
    -   **Sidecar Optimization**: When processing RAW files (e.g., .ARW), it automatically uses sibling JPGs as the source to save bandwidth.
-   **Hierarchical Path Normalization**: Stores folder structures in a `RootPaths` table, treating the scan target's parent as a "Base Root" for easy library relocation.
-   **Smart Filtering**: Automatically ignores "Unknown tags" and non-essential metadata.

## Usage

### Prerequisites
- .NET 8.0 SDK
- TypeScript (`tsc`) for web asset compilation (handled automatically during `dotnet build`)
- `sqlite3` for manual database inspection

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
-   `--testone`: Stop after processing the first file found (debugging).

### UI Controls
-   **Single Click**: Select a photo and load metadata into the sidebar.
-   **Double Click**: Enter **Loupe View** (full-page preview).
-   **'G' Key**: Return to **Grid View**.
-   **Sidebar Resizer**: Drag the left edge of the metadata panel to resize.

### Helper Scripts
-   `./run.sh`: Wrapper for `dotnet run`.
-   `./test.sh`: Generates a 10-file test set from your library and dumps database tables.
-   `./testhost.sh`: Quickly launches the web viewer (port 8080) using test data.
-   `./publish.sh`: Creates a self-contained, single-file Linux-x64 executable in `./dist`.

## Database Schema

-   **RootPaths**: Recursive folder hierarchy.
-   **FileEntry**: Core file records (references `RootPaths`).
-   **Metadata**: Key-Value pairs for all extracted photo data.
-   **Previews**: Binary JPG blobs indexed by `FileId` and `LongEdge` size.