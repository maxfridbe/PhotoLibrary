# PhotoLibrary

A C# CLI application designed to scan photo directories and index metadata into a SQLite database efficiently, optimized for slow network drives (CIFS/SMB).

## Features
- **Efficient Network Scanning**: Reads only the first 1MB of each file to extract headers/metadata, significantly improving performance on high-latency mounts.
- **Hierarchical Path Normalization**: Uses a `RootPaths` table to store folder structures. The parent of your scan target is treated as the "Base Root", allowing for easy library relocation.
- **Metadata Extraction**: Utilizes `MetadataExtractor` to pull Exif, XMP, and other tags.
- **Smart Filtering**: Automatically ignores "Unknown tags" to keep the database clean and useful.
- **Deduplication**: Uses `UPSERT` logic to update existing file records if they are re-scanned.

## Usage

### Prerequisites
- .NET 8.0 SDK
- `sqlite3` (optional, for manual DB inspection)

### Commands
```bash
./run.sh --library <database_path> --updatemd <directory_to_scan> [--testone]
```

- `--library`: Path to the SQLite database.
- `--updatemd`: Directory to scan.
- `--testone`: (Optional) Stop after processing the first file found. Useful for debugging metadata extraction.

### Helper Scripts
- `./run.sh`: Wrapper for `dotnet run`.
- `./test.sh`: Runs a test scan on local sample images and dumps the resulting database tables.
- `./publish.sh`: Compiles a self-contained, single-file executable for Linux-x64 into the `./dist` folder.

## Database Schema

### Table: RootPaths
Stores the directory hierarchy.
- `Id`: GUID (Primary Key)
- `ParentId`: GUID (Self-referencing Foreign Key)
- `Name`: Folder name (or absolute base path for top-level roots)

### Table: FileEntry
Stores basic file information.
- `Id`: GUID (Primary Key)
- `RootPathId`: Foreign Key to `RootPaths.Id`
- `FileName`: The name of the file
- `Size`: File size in bytes
- `CreatedAt` / `ModifiedAt`: ISO-8601 timestamps

### Table: Metadata
Stores extracted metadata tags.
- `FileId`: Foreign Key to `FileEntry.Id`
- `Directory`: The metadata group (e.g., Exif IFD0, XMP, Sony)
- `Tag`: The name of the tag (e.g., Model, Exposure Time)
- `Value`: The string representation of the metadata value