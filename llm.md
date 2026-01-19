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

## 5. Project Structure & Build Orchestration
The project uses a clean separation between source code and tooling.

- **`PhotoLibrary/`**: ASP.NET Core web server and frontend source (`wwwsrc/`).
- **`PhotoLibrary.Backend/`**: Core library processing and database management.
- **`TypeGen/`**: Roslyn-based TS interface generator.
- **`Tooling/`**: Centralized directory for all build, test, and packaging scripts.
  - `version.txt`: The single source of truth for the project version.
  - `build.sh` / `publish.sh`: Manual build entry points.
  - `buildAndPublish.sh`: Core build orchestration used by CI.
  - `Build_full.sh`: Comprehensive build script that cleans and runs all build/packaging steps.
  - `publish-windows-installer.sh`: Inno Setup orchestration via Podman.
  - `make_appimage_rpm_deb.sh`: Linux packaging via nfpm.
  - `clean.sh`: Deep clean script for the entire project.
- **`PhotoLibrary.sln`**: Root solution file.
- **`Directory.Build.props`**: Synchronizes assembly versions across all projects using `Tooling/version.txt`.

## 6. CI/CD & Distribution
The project employs a parallelized GitHub Actions workflow:
- **Parallel Builds**: Linux and Windows artifacts are built concurrently in separate jobs.
- **Embedded Assets**: Frontend assets (`wwwroot`) are embedded as resources in the binary. Physical `wwwroot` folders are excluded from installers to reduce size.
- **Functional Releases**: GitHub Releases are automatically created and populated with all artifacts (EXE, AppImage, DEB, RPM) when a commit is tagged as `functional`.

## 7. Development Standards
- **Requirement Traceability**: Every major function must be tagged with a requirement ID from `requirements.md` (e.g., `// REQ-SVC-00001`).
- **Standardized DTOs**: Models must be defined in `Requests.cs` or `Responses.cs` for TypeGen to function.
- **Stateless Server**: Grouping and display logic (like "Stacking") is handled strictly on the client; the server remains a flat, fast data provider.
- **Surgical DOM**: Use `document.createElement` and `textContent` to ensure stability and performance in the Snabbdom-based UI.
