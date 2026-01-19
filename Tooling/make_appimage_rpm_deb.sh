#!/bin/bash
set -e

# Ensure we are in the project root
cd "$(dirname "$0")/.."

# Configuration
IMAGE_NAME="photolibrary-builder-multi"

echo "Building Podman unified build environment image..."
podman build -t $IMAGE_NAME -f Tooling/Dockerfile.package .

echo "Running Podman build environment to create packages (AppImage, RPM, DEB)..."
# Mount the entire source directory to /src
podman run --rm \
    -v "$(pwd):/src:Z" \
    $IMAGE_NAME

echo ""
echo "Packaging complete! Generated files:"
ls -lh dist/packages/