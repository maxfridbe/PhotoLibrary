# Application Requirements

## Architecture (ARCH) Requirements
- REQ-ARCH-00001: The system shall utilize a custom binary WebSocket protocol for high-speed, low-latency image delivery.
- REQ-ARCH-00002: The frontend shall be implemented in TypeScript to provide compile-time type safety and enhanced maintainability.
- REQ-ARCH-00003: The frontend shall follow a "Manager-Component" pattern to ensure modularity and clear separation of concerns.
- REQ-ARCH-00004: The backend shall be built on .NET 8 to leverage modern performance features and high concurrency support.
- REQ-ARCH-00005: The system shall use SQLite for lightweight, file-based relational data storage with WAL mode enabled for concurrency.
- REQ-ARCH-00006: The system shall implement an automated type-generation pipeline to keep frontend interfaces in sync with backend models.
- REQ-ARCH-00007: All HTTP API endpoints shall use the POST method and JSON payloads for request data, avoiding query string parameters (excluding binary download and stream endpoints).
- REQ-ARCH-00008: The server shall remain stateless, offloading grouping, stacking, and display logic to the client to ensure high scalability.
- REQ-ARCH-00009: Stacking (e.g., JPG+RAW grouping) shall be handled exclusively by the client to maintain backend simplicity and performance.
- REQ-ARCH-00010: The system shall support multiple concurrent frontend instances by tracking client identifiers to route private responses while broadcasting global library events.
- REQ-ARCH-00011: The system shall utilize the WebP format for all thumbnails and previews to optimize storage and transfer efficiency.
- REQ-ARCH-00012: ANY and all DOM references in typescript must have a $prefix ie, $loupe to denote a dom reference.
- REQ-ARCH-00013: All HTTP communications (excluding WebSockets) shall be conducted through the generated TypeScript API wrappers in 'Functions.generated.ts' to ensure type safety and consistent endpoint usage.
- REQ-ARCH-00014: Rotation and view settings (zoom, pan) shall be persisted in the 'Settings' table, keyed by the image's SHA-256 or xxHash64 hash to ensure consistency even if files are moved or renamed.
- REQ-ARCH-00015: The system shall not use magic strings for database table or column names; all references must use centralized constants (e.g., TableConstants) to ensure schema consistency and prevent runtime errors.
- REQ-ARCH-00016: The '/wwwroot' directory shall be treated as a transient, build-generated artifact; all web source files, assets, and original templates must reside in '/wwwsrc', which serves as the authoritative source of truth for the frontend.
- REQ-ARCH-00017: The system shall enforce a strict multi-project architecture to ensure layer separation: core business logic and image processing (Backend) must remain decoupled from the web server/API surface (Presentation), and data access (DataLayer) must be abstracted from processing logic.
- REQ-ARCH-00018: The application version shall be maintained in a single 'version.txt' file (format 1.2.YY.MMDD) and propagated to the UI, binary assembly metadata, and package manifests during the deployable build process to ensure consistency (manual dotnet builds are excluded from this requirement).
- REQ-ARCH-00019: The backend logic shall be exposed via a dedicated CommunicationLayer using an RPC-style pattern, ensuring that core processing and data retrieval are entirely decoupled from web-specific transport details (e.g., HTTP results, content-type mapping).
- REQ-ARCH-00020: All service-layer components (CommunicationLayer, DatabaseManager, ImageIndexer, PreviewManager, CameraManager) shall be defined by interfaces in the .Contracts project (or local to the implementation if specific dependencies like SQLite are required) to facilitate decoupling and testability via dependency injection.
- REQ-ARCH-00021: The system shall utilize explicit callback registration methods (e.g., RegisterHandler) instead of standard C# events for passing data or notifications across architectural boundaries, ensuring clearer ownership and easier lifecycle management.
- REQ-ARCH-00022: The system shall prefer relative units (specifically 'em') for all layout dimensions, spacing, and positioning where appropriate, ensuring that the interface maintains consistent proportions and scalability across different resolutions and font sizes.

## Service (SVC) Requirements
- REQ-SVC-00001: [Performance] Minimal bandwidth usage on high-latency network mounts via header-only metadata extraction (256KB default, 1MB for .cr3).
- REQ-SVC-00002: [Functionality] Hierarchical root path management with recursive normalization and proactive parenting.
- REQ-SVC-00003: [Performance] High-speed binary WebSocket protocol for image delivery to minimize serialization latency.
- REQ-SVC-00004: [Performance] Optimized preview generation using automatic sidecar JPG detection for RAW files.
- REQ-SVC-00005: [Functionality] Decoupled storage architecture using multiple SQLite databases for metadata and binary blobs.
- REQ-SVC-00006: [Functionality] Cross-stack type safety via automated Roslyn-based TypeScript interface generation.
- REQ-SVC-00007: [Performance] Just-in-time preview generation for missing cache entries to ensure seamless browsing.
- REQ-SVC-00008: [Functionality] Stable file and folder identification through proactive hierarchy reconstruction and xxHash64.
- REQ-SVC-00009: [Functionality] Reliable task management with integrated cancellation support for background operations.
- REQ-SVC-00010: [Functionality] Real-time state synchronization across all clients via persistent WebSocket broadcasting.
- REQ-SVC-00011: [Security] Secure path resolution logic to prevent unauthorized filesystem access or directory traversal.
- REQ-SVC-00012: [Functionality] Advanced search engine supporting path segments, metadata tag existence/values, and numeric file size comparisons (>, <).
- REQ-SVC-00013: [Functionality] Persistent storage for application settings, themes, and user preferences via a Settings table and local configuration files.

## Web Front End (WFE) Requirements
- REQ-WFE-00001: User should be able to browse massive libraries smoothly via a 60fps virtualized rendering engine.
- REQ-WFE-00002: User should experience flicker-free navigation through aggressive DOM recycling and element caching.
- REQ-WFE-00003: User should be able to personalize the UI with dynamic themes that persist across sessions.
- REQ-WFE-00004: User should be able to view custom metadata overlays in Loupe mode using variable placeholders.
- REQ-WFE-00005: User should be able to visualize lens and sensor parameters through interactive SVG renders.
- REQ-WFE-00006: User should be able to perform professional-grade culling using a complete keyboard-driven interaction model.
- REQ-WFE-00007: User should see images appear instantly via a progressive staged resolution loading pipeline.
- REQ-WFE-00008: User should be able to use browser back/forward buttons and deep-links via complete URL state synchronization.
- REQ-WFE-00009: User should be able to monitor the real-time progress of folder operations directly in the sidebar tree.
- REQ-WFE-00010: User should see rotated portrait images perfectly fitted to their containers without any cropping.
- REQ-WFE-00011: User should benefit from a modular and decoupled architecture powered by a type-safe internal event bus.
- REQ-WFE-00012: User should be able to switch between Grid, Loupe, and Library view modes.
- REQ-WFE-00013: User should be able to select a photo to view its details and metadata.
- REQ-WFE-00014: User should be able to toggle the visibility of the Library and Metadata sidebars.
- REQ-WFE-00015: User should be able to search the library by filename or specific metadata tags.
- REQ-WFE-00016: User should be able to filter the current view by rating, pick status, or folder.
- REQ-WFE-00017: User should be able to create and manage custom collections of photos.
- REQ-WFE-00018: User should be able to download selected photos as a ZIP archive.
- REQ-WFE-00019: User should be able to see a filmstrip of the current filter while in Loupe mode.
- REQ-WFE-00020: User should be able to zoom and pan high-resolution images in Loupe mode.
- REQ-WFE-00021: User should be able to perform multi-criteria searches including folder/name paths, metadata tags, and file size comparisons.
- REQ-WFE-00022: User should be able to build complex search queries using an interactive query builder overlay.
- REQ-WFE-00023: User should be able to reveal a photo in its containing folder from search results.
- REQ-WFE-00024: User should be able to view real-time system statistics (memory usage, network bandwidth) in the top-right corner of the interface.

## Infrastructure (INFRA) Requirements
- REQ-INFRA-00001: The system shall provide a `build.sh` script for fast local development that reads the version from `version.txt`, updates the frontend version file, and runs a standard dotnet build.
- REQ-INFRA-00002: The system shall provide a `buildAndPublish.sh` script for release builds that updates package manifests, generates frontend assets, and produces a self-contained single-file Linux executable.
- REQ-INFRA-00003: The system shall provide a containerized packaging pipeline (`make_appimage_rpm_deb.sh`) that generates AppImage, RPM, and DEB packages from the publish artifacts.
- REQ-INFRA-00004: The system shall provide a `run.sh` helper script to execute the locally built binary for testing purposes.
- REQ-INFRA-00005: The system shall provide an `updateVersion.sh` utility to automate version incrementing while maintaining the 1.2.YY.MMDD format.
- REQ-INFRA-00006: The system shall support building a self-contained Windows executable (`PhotoLibrary.exe`) via `build-windows.sh` and validating it via `test-windows.sh`.

