#!/bin/bash
set -e

# Clean up
echo "Cleaning up..."
rm -rf dist
rm -rf PhotoLibrary/wwwroot
rm -f PhotoLibrary/wwwroot.zip
mkdir -p PhotoLibrary/wwwroot

# Ensure we are in the project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

# Build and Publish
# The .csproj handles running tsc and embedding files from wwwroot
echo "Building and publishing project..."
dotnet publish PhotoLibrary/PhotoLibrary.csproj -c Release -r linux-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -p:DebugSymbols=false -o dist/linux

# Cleanup dist - we ONLY want the executable
echo "Cleaning up distribution folder..."
cd dist/linux
rm -rf wwwroot
rm -f wwwroot.zip
rm -f *.pdb
rm -f tsconfig.json
cd ../..

echo "Build complete. Output is in ./dist/linux/PhotoLibrary"
