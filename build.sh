#!/bin/bash
set -e

# Clean up
echo "Cleaning up..."
rm -rf dist
rm -rf PhotoLibrary/wwwroot
mkdir -p PhotoLibrary/wwwroot

# Ensure we are in the project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

# Install dependencies if needed (for CI environments)
# npm install -g typescript

# Build and Publish
echo "Building and publishing project..."
dotnet publish PhotoLibrary/PhotoLibrary.csproj -c Release -r linux-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -p:DebugSymbols=false -o dist/linux

# Zip wwwroot and cleanup dist
echo "Packaging frontend assets..."
cd dist/linux
zip -r wwwroot.zip wwwroot
rm -rf wwwroot
rm -f *.pdb
rm -f tsconfig.json
cd ../..

echo "Build complete. Output is in ./dist/linux"
