# Requirements Validation To-Do List

This document tracks violations and gaps between the current implementation and the `requirements.md` specifications.

## 1. Architecture (ARCH) Violations
- [x] **REQ-ARCH-00012 (DOM Prefix)**: All DOM and VNode references in `LibraryManager.tsx` and `app.tsx` now use the mandated `$` prefix.
- [x] **REQ-ARCH-00013 (Generated Wrappers)**: `LibraryManager.tsx` and other frontend components now exclusively use type-safe `Api` wrappers.
- [x] **REQ-ARCH-00015 (No Magic Strings)**: Centralized constants are now used for all database table and column names, including temporary tables.
- [x] **REQ-ARCH-00008/00009 (Client-side Stacking)**: `PhotoResponse` now includes the server-calculated `BaseName`, enabling efficient client-side stacking.

## 2. Web Front End (WFE) Gaps
- [x] **REQ-WFE-00004 (Metadata Overlays)**: The Loupe overlay now supports intuitive short-hands like `{ISO}`, `{Exposure}`, `{Lens}`, `{Aperture}`, `{Camera}`, and `{FocalLength}`.
- [x] **REQ-WFE-00022 (Query Builder)**: The query builder in `SearchBox.tsx` has been improved with better DOM reference handling and automatic field clearing for better interactivity.

## 3. Infrastructure (INFRA) Gaps
- [x] (N/A - manual builds excluded from version consistency)

## 4. Service (SVC) Gaps
- [x] **REQ-SVC-00011 (Secure Path Resolution)**: `PathUtils.cs` has been strengthened with `IsPathInside` to explicitly prevent directory traversal, backed by unit tests.
