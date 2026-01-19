#!/bin/bash
cd "$(dirname "$0")/.."
echo "Cleaning wwwroot..."
rm -rf PhotoLibrary/wwwroot/*

# Build the project once to ensure artifacts are ready
dotnet build PhotoLibrary.sln -c Release

# Linux x64
echo "Publishing for Linux (x64)..."
dotnet publish PhotoLibrary/PhotoLibrary.csproj -c Release -r linux-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist/linux

echo "Done. Executable is in ./dist/linux/PhotoLibrary"