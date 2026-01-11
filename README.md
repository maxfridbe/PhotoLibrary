# PhotoLibrary

A C# CLI application to scan photo directories and index metadata into a SQLite database efficiently.

## Features
- Scans a specified directory for files.
- Reads only the first 1MB of each file to extract metadata (optimization for slow network drives).
- Stores file information and metadata in a SQLite database.
- Updates existing records if re-scanned.

## Usage
```bash
dotnet run -- --library <database_path> --updatemd <directory_to_scan>
```

Example:
```bash
dotnet run -- --library raid.db --updatemd ~/Pictures/raid/
```

## Database Schema

### Table: FileEntry
Stores basic information about each file found.

| Column | Type | Description |
|---|---|---|
| Id | TEXT (GUID) | Primary Key |
| RootPath | TEXT | The root directory scanned |
| FileName | TEXT | Name of the file |
| RelativePath | TEXT | Path relative to the RootPath |
| FullPath | TEXT | Full absolute path (Indexed) |
| Size | INTEGER | File size in bytes |
| CreatedAt | TEXT | File creation time |
| ModifiedAt | TEXT | File modification time |

### Table: Metadata
Stores extracted metadata tags for each file in a Key-Value format.

| Column | Type | Description |
|---|---|---|
| FileId | TEXT (GUID) | Foreign Key to FileEntry.Id |
| Directory | TEXT | The metadata directory (e.g., Exif IFD0, XMP) |
| Tag | TEXT | The name of the tag (e.g., Model, Date/Time) |
| Value | TEXT | The value of the tag |

## Development
This project uses:
- `Microsoft.Data.Sqlite` for database access.
- `System.CommandLine` for CLI argument parsing.
- `MetadataExtractor` for reading image metadata.
