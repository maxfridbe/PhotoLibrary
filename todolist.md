# Backend Unit Testing To-Do List

This document tracks the testing requirements for the `PhotoLibrary.Backend` components.

## Core Principles
- **Isolation**: All tests must use temporary directories and unique database files.
- **Cleanup**: Tests must automatically delete all temporary files and directories upon completion (or failure).
- **No Side Effects**: Tests must NEVER touch `~/.config/`, production databases, or any shared user state.
- **Self-Sufficient**: Tests must generate their own test assets (images with metadata, directories) programmatically.

## 1. DatabaseManager (DataLayer)
- [x] **Schema Initialization**: Verify all tables (`RootPaths`, `FileEntry`, `Metadata`, etc.) are created correctly on first run.
- [x] **Root Management**:
    - [x] Test `GetOrCreateBaseRoot` and `GetOrCreateChildRoot`.
    - [x] Verify `NormalizeRoots` correctly cleans up or fixes path inconsistencies.
    - [x] Test recursive root ID retrieval.
- [x] **File Entry CRUD**:
    - [x] Test `UpsertFileEntry` (Insert new vs. Update existing).
    - [x] Verify `GetFileId` and `GetFileIdWithConnection`.
    - [x] Test `GetExistingFileStatus` (mtime/size comparison).
- [x] **Metadata**:
    - [x] Test `InsertMetadata` and `GetMetadata`.
    - [x] Verify large metadata value truncation.
- [x] **Collections**:
    - [x] Test creation, deletion, and adding files.
    - [x] Verify retrieval of files within a collection.
- [ ] **Search Logic**:
    - [ ] Test tag-based searching.
    - [ ] Test complex query string parsing.
- [x] **Forgetting Folders**:
    - [x] Verify `ForgetRoot` recursively deletes everything (Metadata, Collections, Files, Roots).

## 2. ImageIndexer (ProcessingLayer)
- [x] **Scanning**:
    - [x] Test recursive directory enumeration.
    - [x] Verify change detection (only processing modified files).
- [x] **Hashing**:
    - [x] Verify `XxHash64` consistency.
- [x] **Metadata Extraction**:
    - [x] Test EXIF/IPTC extraction for JPG.
    - [x] Test Sony ARW (RAW) metadata fallbacks.
- [x] **ProcessSingleFileFromSource**:
    - [x] **CRITICAL**: Verify indexing from a source path while recording a different target path in DB.
    - [x] Verify thumbnail generation happens from the source file.

## 3. CommunicationLayer (Business Logic)
- [x] **Local Import Workflow**:
    - [x] Test path projection using directory templates (`{YYYY}`, `{Date}`, etc.).
    - [x] Test duplicate detection by Name.
    - [x] Test duplicate detection by Hash.
    - [x] Verify the optimized flow: Index -> Copy.
- [x] **Validate Import**:
    - [x] Verify recursive disk checks for existing files in destination roots.
- [ ] **Thumbnail Generation Orchestration**:
    - [ ] Test `GenerateThumbnails` background task enqueuing.
    - [ ] Test `ForceUpdatePreview` logic (delete + regenerate).
- [x] **Export**:
    - [x] Test Zip archive creation for original files.
    - [ ] Test Zip archive creation for previews.
    - [x] Verify filename collision handling in export zips.

## 4. PreviewManager (ProcessingLayer)
- [x] **Thumbnail Creation**:
    - [x] Test resizing logic (preserving aspect ratio).
    - [x] Test RAW sidecar detection (looking for .JPG/.jpg next to RAW).
    - [x] Verify WebP encoding and quality settings.
- [x] **Storage**:
    - [x] Test `SavePreview` and `GetPreviewData`.
    - [x] Test `DeletePreviewsByHash`.

## 5. Utilities
- [ ] **PathUtils**:
    - [ ] Test `ResolvePath` with `~` and relative paths.
    - [ ] Verify consistent behavior across Linux/Windows path separators.
- [ ] **ReadTrackingStream**:
    - [ ] Verify byte counting for runtime statistics.