# Design Methodology: PhotoLibrary

This document outlines the architectural principles, performance strategies, and development patterns used in the PhotoLibrary project.

## 1. Core Philosophy: "Performance First"
The system is built to handle hundreds of thousands of images over slow network mounts (CIFS/SMB) without sacrificing responsiveness.

### Efficient Scanning
- **1MB Header Optimization**: The scanner only reads the first 1MB of large image files (RAW/ARW/NEF) to extract metadata, avoiding massive bandwidth consumption on slow drives.
- **Path Normalization**: Uses a hierarchical `RootPaths` table to represent directory structures, allowing for library portability and efficient folder-based filtering.

### Binary Image Streaming
- **Binary WebSocket Protocol**: Thumbnails and previews are delivered over a custom binary WebSocket protocol. This avoids the overhead of Base64 encoding and reduces HTTP request latency.
- **Sidecar-Aware Previews**: The system automatically detects sibling JPGs for RAW files (ARW/NEF), using them as high-speed sources for preview generation.

## 2. Frontend Architecture: "Manager-Component Pattern"
The UI is a TypeScript SPA broken down into specialized managers to ensure maintainability.

### Specialized Managers
- **CommunicationManager (`CommunicationManager.ts`)**: Centralizes the network layer, including the binary WebSocket protocol for image streaming and real-time push notifications.
- **ThemeManager (`ThemeManager.ts`)**: Manages dynamic theming (20+ palettes), user preference persistence, and the customizable Loupe overlay.
- **LibraryManager (`LibraryManager.ts`)**: Handles "Library Mode", including targeted batch imports, progress tracking, and hierarchy visualization.
- **App (`app.ts`)**: Acts as the root orchestrator and UI coordinator.

### Surgical UI (Flicker-Free)
- **Virtualized Grid**: Only the visible subset of images is rendered. 
- **DOM Recycling**: Reuses `HTMLElement` nodes via a `cardCache` to prevent "black flashes".
- **Dynamic Overlays**: Customizable Loupe overlays with support for any metadata via `{MD:tag}` syntax.

## 3. Backend Architecture: "Minimalist & Normalized"
The backend is a .NET 8 application focused on providing high-concurrency and efficient SQLite storage.

### Smart Indexing & Previews
- **Targeted Imports**: Backend supports batch importing specific relative paths to avoid full directory re-scans.
- **On-the-Fly Generation**: If a requested preview is missing, it's generated live from the source (respecting RAW sidecars) and cached in the database.
- **Cycle-Safe Paths**: Manual path reconstruction logic with recursive loop detection ensures stability even with complex directory structures.

### Normalized Storage
- **Decoupled User Data**: User culling data (ratings/picks) is stored in specialized tables.
- **Centralized Configuration**: Persistent app settings (themes, overlays) stored in a `Settings` table and local `config.json`.

## 4. Interaction Model: "The Keyboard Professional"
The UI is inspired by Adobe Lightroom, optimized for power users:
- **Navigation**: Full arrow-key support across all views.
- **Speed Culling**: Numerical keys (1-5) and 'P' for flags are instant and stack-aware.
- **Global Feedback**: Toast notification system for all background processes and user actions.

## 5. Project Structure & Layout
- **Backend (Root)**: .NET 8 core logic and WebServer.
- **Frontend Source (`wwwsrc/`)**: Modularized TypeScript source.
- **Build Output (`wwwroot/`)**: Transient artifacts embedded into the assembly.
- **Build Orchestration**: `.csproj` manages the entire pipeline: `TypeGen` -> `tsc` -> Sync -> Compile.

## 6. Development Standards
- **Standardized DTOs**: All request/response models must be defined in `Requests.cs` or `Responses.cs` to ensure they are picked up by the Roslyn generator.
- **Surgical DOM**: Avoid `innerHTML` for dynamic content. Use `document.createElement` and `textContent` to maintain stability and prevent XSS or malformed literal issues.
- **Stateless Server**: The server should remain as stateless as possible, pushing grouping and display logic to the client to maximize scalability.
