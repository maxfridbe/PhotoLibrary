# Application Requirements

## Architecture (ARCH) Requirements
- REQ-ARCH-00001: The system shall utilize a custom binary WebSocket protocol for high-speed, low-latency image delivery.
- REQ-ARCH-00002: The frontend shall be implemented in TypeScript to provide compile-time type safety and enhanced maintainability.
- REQ-ARCH-00003: The frontend shall follow a "Manager-Component" pattern to ensure modularity and clear separation of concerns.
- REQ-ARCH-00004: The backend shall be built on .NET 8 to leverage modern performance features and high concurrency support.
- REQ-ARCH-00005: The system shall use SQLite for lightweight, file-based relational data storage with WAL mode enabled for concurrency.
- REQ-ARCH-00006: The system shall implement an automated type-generation pipeline to keep frontend interfaces in sync with backend models.
- REQ-ARCH-00007: All HTTP API endpoints shall use the POST method and JSON payloads for request data, avoiding query string parameters.

## Service (SVC) Requirements
- REQ-SVC-00001: [Performance] Minimal bandwidth usage on high-latency network mounts via 1MB header-only metadata extraction.
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
