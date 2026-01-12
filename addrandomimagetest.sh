#!/bin/bash
# Script to add one random image from the 2022 raid directory to the test dir

RAID_SOURCE="$HOME/Pictures/raid/2022"
TEST_DIR="./test_images"

if [ ! -d "$RAID_SOURCE" ]; then
    echo "Error: Source directory $RAID_SOURCE does not exist."
    exit 1
fi

mkdir -p "$TEST_DIR"

echo "Finding all images in $RAID_SOURCE (this may take a moment over network)..."
# Find all JPG or ARW files
mapfile -t files < <(find "$RAID_SOURCE" -type f -regextype posix-extended -iregex ".*\.(jpg|arw)" 2>/dev/null)

if [ ${#files[@]} -eq 0 ]; then
    echo "No images found in $RAID_SOURCE."
    exit 1
fi

# Pick a random one
random_idx=$(( RANDOM % ${#files[@]} ))
src="${files[$random_idx]}"

# Calculate destination path relative to RAID root to keep structure if needed,
# or just relative to the 2022 folder.
RAID_BASE="$HOME/Pictures/raid"
rel_path="${src#$RAID_BASE/}"
dest="$TEST_DIR/$rel_path"

mkdir -p "$(dirname "$dest")"
echo "Copying random image:"
echo "Source: $src"
echo "Dest:   $dest"

if cp "$src" "$dest"; then
    echo "Successfully added 1 random image to test set."
else
    echo "Failed to copy image."
    exit 1
fi
