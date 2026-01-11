#!/bin/bash
# Setup test environment
rm -f test.db
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

# Run with --testone (Note: --testone only processes ONE file, so it will pick one of them)
echo "Running test with --testone..."
./run.sh --library test.db --updatemd "$TEST_DIR" --testone

# Check if db was created
if [ -f "test.db" ]; then
    echo "Success: Database created."
    echo "=========================================="
    echo "Dumping Table: FileEntry"
    echo "=========================================="
    sqlite3 -header -column test.db "SELECT * FROM FileEntry;"
    
    echo ""
    echo "=========================================="
    echo "Dumping Table: Directories"
    echo "=========================================="
    sqlite3 -header -column test.db "SELECT * FROM Directories;"

    echo ""
    echo "=========================================="
    echo "Dumping Table: Metadata"
    echo "=========================================="
    sqlite3 -header -column test.db "SELECT * FROM Metadata LIMIT 50;"
else
    echo "Failure: Database not created."
fi

# Clean up (optional, keep for inspection)
# rm -rf "$TEST_DIR" test.db