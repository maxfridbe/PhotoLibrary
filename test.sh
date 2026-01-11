#!/bin/bash
# Setup test environment
rm -f test.db previews.db
TEST_DIR="./test_images"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

# Copy real test images
echo "Copying test images..."
if [ ! -f "$TEST_DIR/MAX01109.ARW" ]; then
    cp "/var/home/maxfridbe/Pictures/raid/2025/2025-12-19/MAX01109.ARW" "$TEST_DIR/"
fi
if [ ! -f "$TEST_DIR/MAX01109.JPG" ]; then
    cp "/var/home/maxfridbe/Pictures/raid/2025/2025-12-19/MAX01109.JPG" "$TEST_DIR/"
fi

# Run with --testone AND --updatepreviews
# We use --testone so it only processes the first file it finds (could be ARW or JPG).
# If it finds ARW first, it should use the JPG sidecar for preview.
echo "Running test with --testone and --updatepreviews..."
./run.sh --library test.db --updatemd "$TEST_DIR" --testone --updatepreviews --previewdb previews.db --longedge 1024 --longedge 300

# Check if db was created
if [ -f "test.db" ]; then
    echo "Success: Main Database created."
else
    echo "Failure: Main Database not created."
fi

if [ -f "previews.db" ]; then
    echo "Success: Preview Database created."
    echo "=========================================="
    echo "Dumping Table: Previews (Schema & Stats)"
    echo "=========================================="
    sqlite3 -header -column previews.db "SELECT FileId, LongEdge, length(Data) as SizeBytes FROM Previews;"
else
    echo "Failure: Preview Database not created."
fi