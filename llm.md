To build the project, run `dotnet build`. This will also build the TypeScript files.

# Design Methodology: PhotoLibrary

This document outlines the architectural principles, performance strategies, and development patterns used in the PhotoLibrary project.

## 1. Core Philosophy: "Performance First"
The system is built to handle hundreds of thousands of images over slow network mounts (CIFS/SMB) without sacrificing responsiveness.

### Efficient Scanning
- **1MB Header Optimization**: The indexer only reads the first 1MB of large image files (RAW/ARW/NEF/CR3/DNG/etc.) to extract metadata, avoiding massive bandwidth consumption on slow drives.
- **Path Normalization**: Uses a hierarchical `RootPaths` table to represent directory structures, allowing for library portability and efficient folder-based filtering.

### Binary Image Streaming
- **Binary WebSocket Protocol**: (See REQ-ARCH-00001) Previews are delivered over a custom binary protocol. This avoids the overhead of Base64 encoding and reduces HTTP request latency.
- **WebP Optimized**: (See REQ-ARCH-00011) All thumbnails and previews use the WebP format (Quality 80) for superior compression and faster transfer.
- **Concurrent Processing**: (See REQ-ARCH-00010) The backend handles WebSocket requests in parallel background tasks, ensuring high-priority navigation is never blocked by background image processing.
- **Request De-duplication**: The frontend maintains a `pendingRequests` map to prevent redundant network traffic for the same asset.


## 2. Frontend Architecture: "Manager-Component Pattern"
The UI is a TypeScript SPA broken down into specialized managers to ensure maintainability.

### Specialized Managers
- **App (`PhotoLibrary/wwwsrc/app.ts`)**: Acts as the root orchestrator and UI coordinator, managing layout registration and high-level state.
- **CommunicationManager (`PhotoLibrary/wwwsrc/CommunicationManager.ts`)**: Centralizes the network layer, including the binary WebSocket protocol for image streaming, request queueing, and real-time push notifications.
- **ThemeManager (`PhotoLibrary/wwwsrc/ThemeManager.ts`)**: Manages dynamic theming (20+ palettes defined in `PhotoLibrary/wwwsrc/themes.ts`), user preference persistence, and Loupe overlay configurations.
- **LibraryManager (`PhotoLibrary/wwwsrc/LibraryManager.ts`)**: Handles "Library Mode", including targeted batch imports, directory scanning, and import progress visualization.
- **GridView (`PhotoLibrary/wwwsrc/grid.ts`)**: Manages the virtualized image grid and filmstrip, implementing DOM recycling and lazy-loading for performance.
- **PubSub (`PhotoLibrary/wwwsrc/PubSub.ts`)**: Provides a centralized event bus for decoupled communication between managers and components.
- **Aperture Visualizer (`PhotoLibrary/wwwsrc/aperatureVis.ts`)**: A specialized component for rendering SVG-based lens and sensor metadata visualizations.

### Surgical UI (Flicker-Free)
- **Virtualized Grid (`PhotoLibrary/wwwsrc/grid.ts`)**: Only the visible subset of images is rendered to maintain 60fps performance even with large libraries.
- **DOM Recycling (`PhotoLibrary/wwwsrc/grid.ts`)**: Reuses `HTMLElement` nodes via a `cardCache` to prevent "black flashes" during scrolling.
- **Dynamic Overlays (`PhotoLibrary/wwwsrc/app.ts`)**: Customizable Loupe overlays with support for any metadata via `{MD:tag}` syntax.
- **Metadata Visualization (`PhotoLibrary/wwwsrc/aperatureVis.ts`)**: An SVG-based aperture and FOV visualizer integrated into the metadata panel, providing real-time feedback on lens and sensor parameters.

## 3. Backend Architecture: "Minimalist & Normalized"
The backend is a .NET 8 application focused on providing high-concurrency and efficient SQLite storage.

### Smart Indexing & Previews
- **Targeted Imports**: Backend supports batch importing specific relative paths to avoid full directory re-scans.
- **Advanced Search**: A multi-criteria search engine supporting path segments, metadata tag existence/values (e.g., `tag:ISO`), and numeric file size comparisons (e.g., `size > 2mb`). Includes a "Reveal in Folders" context menu option to jump from search results to the source directory.
- **On-the-Fly Generation**: If a requested preview is missing, it's generated live from the source (respecting RAW sidecars) and cached in the database.
- **Cycle-Safe Paths**: Manual path reconstruction logic with recursive loop detection ensures stability even with complex directory structures.

### Type Generation
- **Detailed Build Output (`TypeGen/`)**: The `TypeGen` utility uses Roslyn to parse C# models and generate TypeScript interfaces, now providing detailed "from -> to" logs during the build process to ensure transparency.

### Normalized Storage
- **Decoupled User Data**: User culling data (ratings/picks) is stored in specialized tables.
- **Centralized Configuration**: (See REQ-SVC-00013) Persistent app settings (themes, overlays) stored in a `Settings` table and local `config.json`.

## 4. Interaction Model: "The Keyboard Professional"
The UI is inspired by Adobe Lightroom, optimized for power users:
- **Navigation**: Full arrow-key support across all views.
- **Speed Culling**: Numerical keys (1-5) and 'P' for flags are instant and stack-aware.
- **Global Feedback**: Toast notification system for all background processes and user actions.

## 5. Project Structure & Layout
- **Backend (`PhotoLibrary/`)**: .NET 8 core logic and WebServer.
- **Type Generation (`TypeGen/`)**: Roslyn-based tool for keeping C# and TS in sync.
- **Frontend Source (`PhotoLibrary/wwwsrc/`)**: Modularized TypeScript source.
- **Build Output (`PhotoLibrary/wwwroot/`)**: Transient artifacts embedded into the assembly.
- **Orchestration (Root)**: Solution file, build/test scripts, and global documentation.

## 6. Development Standards
- **Requirement Traceability**: Every major function in C# and TypeScript must be tagged with the requirement ID it fulfills from `requirements.md` using a comment directly above the function containing ONLY the ID (e.g., `// REQ-SVC-00001` or `// REQ-ARCH-00001`).
- **Standardized DTOs**: All request/response models must be defined in `PhotoLibrary/Requests.cs` or `PhotoLibrary/Responses.cs` to ensure they are picked up by the Roslyn generator.
- **Surgical DOM**: Avoid `innerHTML` for dynamic content. Use `document.createElement` and `textContent` to maintain stability and prevent XSS or malformed literal issues.
- **Stateless Server**: (See REQ-ARCH-00008) The server should remain as stateless as possible, pushing grouping and display logic to the client to maximize scalability. All data-requesting endpoints shall use the POST method and JSON payloads, strictly avoiding query string parameters for request data.
- **UI-Only Stacking**: (See REQ-ARCH-00009) "Stacking" (grouping JPG+RAW) is strictly a client-side visualization concern. The server should never receive or process "stacked" flags or logic; it simply returns flat lists of files.