# Design Methodology: PhotoLibrary

This document outlines the architectural principles, performance strategies, and development patterns used in the PhotoLibrary project.

## 1. Core Philosophy: "Performance First"
The system is built to handle hundreds of thousands of images over slow network mounts (CIFS/SMB) without sacrificing responsiveness.

### Efficient Scanning
- **1MB Header Optimization**: The scanner only reads the first 1MB of large image files (RAW/ARW) to extract metadata, avoiding massive bandwidth consumption on slow drives.
- **Path Normalization**: Uses a hierarchical `RootPaths` table to represent directory structures, allowing for library portability and efficient folder-based filtering.

### Binary Image Streaming
- **Binary WebSocket Protocol**: Thumbnails and previews are delivered over a custom binary WebSocket protocol. This avoids the overhead of Base64 encoding and reduces HTTP request latency.
- **Sidecar-Aware Previews**: The system automatically detects sibling JPGs for RAW files, using them as high-speed sources for preview generation.

## 2. Frontend Architecture: "Reactive & Decoupled"
The UI is a TypeScript SPA built around stability and instant feedback.

### Surgical UI (Flicker-Free)
- **Virtualized Grid**: Only the visible subset of images is rendered. 
- **DOM Recycling**: Instead of clearing containers, the app reuses `HTMLElement` nodes via a `cardCache`, surgically moving and updating them to prevent "black flashes" during scrolling.
- **Metadata Diffing**: The metadata panel uses a surgical update strategy. It maintains a persistent map of DOM nodes and only updates `textContent` or visibility for specific tags when switching images.

### Event-Driven Communication
- **Pattern-Matching PubSub**: A central Hub (`PubSub.ts`) handles all internal communication. Components subscribe to granular events like `photo.starred.*` or `view.mode.changed`. This decouples UI components from the core application logic.
- **Optimistic UI**: Ratings and flags are updated locally instantly. The application then syncs with the server in the background, reverting state and notifying the user only if the persistence layer fails.

### Local Business Logic
- **UI Stacking**: Stacking (grouping ARW + JPG) is implemented as a **UI Construct**. The server provides a flat list of metadata, and the frontend dynamically groups and sorts them based on user preference. This allows for instant toggling between flat and stacked modes.

## 3. Backend Architecture: "Minimalist & Normalized"
The backend is a .NET 8 application focused on providing a high-concurrency API and efficient SQLite storage.

### Normalized Storage
- **Decoupled User Data**: User culling data (ratings and picks) is stored in specialized tables (`ImageRatings`, `images_picked`) separate from the core `FileEntry` table. This ensures the main file index remains immutable during culling operations.
- **Paged Responses**: Every API endpoint is designed for paging, ensuring that the interface remains snappy regardless of library size.

### Type-Safe Bridge
- **Roslyn-Based Source Generation**: A custom tool (`TypeGen/`) parses C# DTOs and WebServer endpoints using the Roslyn compiler API to automatically generate TypeScript interfaces and API calling functions. This ensures 100% type safety across the network boundary.

## 4. Interaction Model: "The Keyboard Professional"
The UI is inspired by Adobe Lightroom, optimized for power users:
- **Navigation**: Full arrow-key support across virtualized grids.
- **Speed Culling**: Numerical keys (1-5) for ratings and 'P' for flags are instant and require no mouse movement.
- **Contextual Workflows**: Context menus are provided for advanced operations (e.g., "Clear all picked", "Add to collection") based on selected state.

## 5. Development Standards
- **Standardized DTOs**: All request/response models must be defined in `Requests.cs` or `Responses.cs` to ensure they are picked up by the Roslyn generator.
- **Surgical DOM**: Avoid `innerHTML` for dynamic content. Use `document.createElement` and `textContent` to maintain stability and prevent XSS or malformed literal issues.
- **Stateless Server**: The server should remain as stateless as possible, pushing grouping and display logic to the client to maximize scalability.
