# PhotoLibrary

A high-performance C# application designed to scan photo directories, index metadata, and host a web-based "Lightroom-style" viewer. Specifically optimized for slow network drives (CIFS/SMB) and massive libraries.

## Features

-   **Efficient Network Scanning**: Reads only the first 1MB of each file to extract headers/metadata, significantly improving performance on high-latency mounts.
-   **High-Performance Web Interface**:
    -   **Virtualized Grid**: Custom rendering engine that supports hundreds of thousands of images by only rendering what's visible.
    -   **Flicker-Free UI**: Surgical DOM updates and intelligent node recycling prevent visual flashes during navigation.
    -   **Loupe View**: High-resolution preview with a reactive filmstrip for quick navigation.
    -   **Tag Search**: Instant metadata search (e.g., search by Focal Length, Lens, or Filename).
    -   **WebSocket Streaming**: Binary protocol for ultra-fast, low-overhead image delivery.
-   **Organization & Culling**:
    -   **Star Ratings**: Rate photos 1-5 with instant sidebar count updates.
    -   **Flags/Picks**: Flag photos for selection (`⚑`).
    -   **User Collections**: Create custom collections and group flagged images effortlessly.
-   **Architecture**:
    -   **Reactive PubSub Hub**: Decoupled UI components using a pattern-matching event system.
    -   **Surgical Metadata Panel**: Updates only changed values using a DOM-diffing strategy to ensure stability.
    -   **Type-Safe API**: TypeScript models and functions automatically generated from C# DTOs via a Roslyn-based source generator.
    -   **Optimistic UI**: Immediate local feedback for ratings and flags, with background synchronization and error reversal.

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
-   **'L'**: Loupe View (requires a selected image)
-   **'P'**: Toggle Flag (Pick)
-   **'1' - '5'**: Set Star Rating
-   **'0'**: Clear Star Rating
-   **'?'**: Show Shortcuts Dialog
-   **Arrows**: Navigate Grid/Filmstrip

### Helper Scripts
-   `./test.sh`: Samples real images from RAID, preserving folder structure, and generates test DBs.
-   `./testhost.sh`: Launches the web viewer (port 8080) using test data.
-   `./publish.sh`: Creates a self-contained, single-file executable in `./dist`.

## Database Schema

-   **RootPaths**: Recursive folder hierarchy.
-   **FileEntry**: Core file records.
-   **Metadata**: Key-Value pairs for all photo data (Exif, XMP, etc.).
-   **PickedImages / ImageRatings**: User culling data.
-   **UserCollections / CollectionFiles**: Custom user grouping logic.
-   **Previews**: Binary JPG blobs stored in a separate `previews.db`.