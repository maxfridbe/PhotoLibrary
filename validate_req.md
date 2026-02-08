# Requirements Validation To-Do List

This document tracks progress on bringing the codebase into full compliance with `requirements.md`.

## 1. Architecture (ARCH) Fixes
- [x] **REQ-ARCH-00007 (POST-only API)**: Convert `/api/camera/thumbnail` to a POST endpoint with a JSON body and updated generated wrappers to support binary responses.
- [x] **REQ-ARCH-00012 (DOM Prefix)**: Verified all DOM/VNode references in `LibraryManager.tsx` and `app.tsx` use the `$` prefix.
- [x] **REQ-ARCH-00013 (Generated Wrappers)**: All frontend communications now exclusively use type-safe `Api` wrappers, including binary thumbnail fetches.
- [x] **REQ-ARCH-00015 (No Magic Strings)**: Centralized constants used for all database table/column names.
- [x] **REQ-ARCH-00008/00009 (Client-side Stacking)**: `PhotoResponse` now includes `BaseName`.

## 2. Web Front End (WFE) Enhancements
- [x] **REQ-WFE-00004 (Metadata Overlays)**: EXIF short-hands (`{ISO}`, `{Exposure}`, etc.) are implemented.
- [x] **REQ-WFE-00022 (Interactive Query Builder)**: The query builder now displays active search terms as removable pills and automatically clears input fields for improved interactivity.

## 3. Service (SVC) Fixes
- [x] **REQ-SVC-00011 (Secure Path Resolution)**: `PathUtils.IsPathInside` implemented and verified by unit tests.
