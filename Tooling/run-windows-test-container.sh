#!/bin/bash
set -e

# Ensure we are in the project root
cd "$(dirname "$0")/.."

IMAGE_NAME="photolibrary-windows-test"

echo "Building Windows Test Environment..."
podman build -t $IMAGE_NAME -f Tooling/Dockerfile.windows-test .

echo "Running Windows Test in Container..."
# Mount current directory to /src
podman run --rm \
    -v "$(pwd):/src:Z" \
    $IMAGE_NAME