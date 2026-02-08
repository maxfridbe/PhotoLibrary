# Requirements Validation To-Do List

This document tracks violations and gaps between the current implementation and the `requirements.md` specifications.

## 1. Architecture (ARCH) Violations
- [ ] **REQ-ARCH-00012 (DOM Prefix)**: The following variables in `LibraryManager.tsx` lack the required `$` prefix for DOM references:
    - `statsVNode`
    - `locationsVNode`
    - `importVNode`
    - `importStatusVNode`
- [ ] **REQ-ARCH-00013 (Generated Wrappers)**: `LibraryManager.tsx` makes direct calls to the `post()` utility for `backup` and `import-local` instead of using the type-safe `Api` wrappers.
- [ ] **REQ-ARCH-00015 (No Magic Strings)**: `DatabaseManager.cs` contains hardcoded SQL strings for:
    - `LEFT JOIN Settings s` (should use `{TableName.Settings}`)
    - Temporary table names `TempRoots` and `TempFileNames` (should be defined in `TableConstants.cs`).
- [ ] **REQ-ARCH-00008/00009 (Client-side Stacking)**: `PhotoResponse` is missing the `BaseName` property. While stacking logic is offloaded to the client, the client requires this server-side calculated field to efficiently group JPG+RAW or burst sequences.

## 2. Web Front End (WFE) Gaps
- [ ] **REQ-WFE-00004 (Metadata Overlays)**: The Loupe overlay supports `{MD:tag}` but lacks intuitive short-hands for high-value EXIF data (e.g., `{ISO}`, `{Exposure}`, `{Lens}`). Currently, users must know exact internal tag names.
- [ ] **REQ-WFE-00022 (Query Builder)**: The query builder in `SearchBox.tsx` works by appending strings. It should be audited to ensure it supports complex grouped logic or more visual interaction as implied by "interactive query builder".

## 3. Infrastructure (INFRA) Gaps
- [ ] **REQ-SVC-00011 (Secure Path Resolution)**: `PathUtils.cs` should be strengthened to explicitly prevent directory traversal beyond allowed roots, rather than relying solely on `Path.GetFullPath`.
