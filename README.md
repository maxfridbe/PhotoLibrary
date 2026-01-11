# PhotoLibrary

A C# CLI application designed to scan photo directories and index metadata into a SQLite database efficiently, optimized for slow network drives (CIFS/SMB). It also supports generating binary image previews.

## Features
- **Efficient Network Scanning**: Reads only the first 1MB of each file to extract headers/metadata, significantly improving performance on high-latency mounts.
- **Preview Generation**: Generates resized JPG previews stored in a separate SQLite database.
- **Sidecar Optimization**: When generating previews for RAW files (e.g., .ARW), checks for existing sidecar JPGs to use as the source, saving bandwidth and processing time.
- **Hierarchical Path Normalization**: Uses a `RootPaths` table to store folder structures. The parent of your scan target is treated as the "Base Root", allowing for easy library relocation.
- **Metadata Extraction**: Utilizes `MetadataExtractor` to pull Exif, XMP, and other tags.
- **Smart Filtering**: Automatically ignores "Unknown tags" to keep the database clean and useful.
- **Deduplication**: Uses `UPSERT` logic to update existing file records if they are re-scanned.

## Usage

### Prerequisites
- .NET 8.0 SDK
- `sqlite3` (optional, for manual DB inspection)
- Native dependencies for Magick.NET (handled automatically in the self-contained build)

### Commands
```bash
./run.sh --library <database_path> --updatemd <directory_to_scan> [OPTIONS]
```

### Options
- `--library <path>`: **(Required)** Path to the main SQLite database file (stores metadata and file info).
- `--updatemd <path>`: **(Required)** Directory to scan for images.
- `--testone`: (Optional) Stop after processing the first file found. Useful for debugging or quick tests.
- `--updatepreviews`: (Optional) Enable preview generation.
- `--previewdb <path>`: (Required if `--updatepreviews` is used) Path to the SQLite database for storing previews.
- `--longedge <pixels>`: (Required if `--updatepreviews` is used) The target size for the long edge of the preview. Can be specified multiple times for different sizes (e.g., `--longedge 1024 --longedge 300`).
- `--host <port>`: (Optional) Starts a web server on the specified port to view the library (e.g., `--host 8080`). Requires `--library` and `--previewdb`.

### Example
Scan a directory, extract metadata, and generate 1024px and 300px previews:
```bash
./run.sh \
  --library raid.db \
  --updatemd ~/Pictures/raid/2025 \
  --updatepreviews \
  --previewdb previews.db \
  --longedge 1024 \
  --longedge 300
```

### Hosting the Viewer
Start the web viewer on port 8080:
```bash
./run.sh \
  --library raid.db \
  --previewdb previews.db \
  --host 8080
```

### Helper Scripts
- `./run.sh`: Wrapper for `dotnet run`.
- `./test.sh`: Runs a test scan on local sample images and dumps the resulting database tables.
- `./publish.sh`: Compiles a self-contained, single-file executable for Linux-x64 into the `./dist` folder (includes native libraries).

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

### Table: Previews (in `previewdb`)
Stores binary image previews.
- `FileId`: Foreign Key to `FileEntry.Id` (from the main library DB)
- `LongEdge`: The size of the preview (integer)
- `Data`: BLOB (Binary JPG data)
