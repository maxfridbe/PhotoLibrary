#!/bin/bash
set -e

# Ensure we are in the project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

VERSION=$(cat version.txt)
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "Building Version: $VERSION ($BUILD_DATE)"

# Generate frontend version file
echo "export const APP_VERSION = '$VERSION';" > PhotoLibrary/wwwsrc/version.ts
echo "export const BUILD_DATE = '$BUILD_DATE';" >> PhotoLibrary/wwwsrc/version.ts

# Update nfpm.yaml version
sed -i "s/version: \".*\"/version: \"$VERSION\"/" nfpm.yaml

# Clean up
echo "Cleaning up..."
rm -rf dist
rm -rf PhotoLibrary/wwwroot
mkdir -p PhotoLibrary/wwwroot

# Explicitly prepare frontend assets before publish
# This ensures that EmbeddedResource Include="wwwroot\**\*" finds files
echo "Compiling TypeScript..."
cd PhotoLibrary
tsc
cp wwwsrc/index.html wwwroot/
cp wwwsrc/favicon.svg wwwroot/
mkdir -p wwwroot/lib && cp -r wwwsrc/lib/* wwwroot/lib/
cd ..

# Build and Publish
echo "Building and publishing project..."
dotnet publish PhotoLibrary/PhotoLibrary.csproj -c Release -r linux-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -p:DebugSymbols=false -p:BuildMetadata="+$BUILD_DATE" -o dist/linux

# Cleanup dist - we ONLY want the executable
echo "Cleaning up distribution folder..."
cd dist/linux
rm -rf wwwroot
rm -f *.pdb
rm -f tsconfig.json
cd ../..

echo "Build complete. Output is in ./dist/linux/PhotoLibrary"