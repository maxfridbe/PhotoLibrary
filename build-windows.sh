#!/bin/bash
set -e

# Use same version logic
if [ -f version.txt ]; then
    VERSION=$(cat version.txt)
else
    VERSION="1.0.0"
fi

echo "Building Windows Version: $VERSION"

# Ensure frontend assets are built
echo "Compiling TypeScript..."
cd PhotoLibrary
tsc
mkdir -p wwwroot/lib && cp -r wwwsrc/lib/* wwwroot/lib/
cp wwwsrc/index.html wwwroot/
cp wwwsrc/favicon.svg wwwroot/
cd ..

# Build
# We define WINDOWS constant to enable platform-specific logic
dotnet publish PhotoLibrary/PhotoLibrary.csproj \
    -c Release \
    -r win-x64 \
    --self-contained \
    -p:PublishSingleFile=true \
    -p:IncludeNativeLibrariesForSelfExtract=true \
    -p:DebugType=None \
    -p:DebugSymbols=false \
    -p:Version=$VERSION \
    -p:DefineConstants="WINDOWS" \
    -o dist/win-x64

echo "Windows build complete: dist/win-x64/PhotoLibrary.exe"
