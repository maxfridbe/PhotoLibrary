#!/bin/bash
set -e

IMAGE_NAME="photolibrary-windows-test"

echo "Building Windows Test Environment..."
podman build -t $IMAGE_NAME -f Dockerfile.windows-test .

echo "Running Windows Test in Container..."
# Mount current directory to /src
podman run --rm \
    -v "$(pwd):/src:Z" \
    $IMAGE_NAME
