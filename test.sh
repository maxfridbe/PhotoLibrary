#!/bin/bash
# Setup test environment
rm -f test.db previews.db
TEST_DIR="./test_images"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

# Find and copy 10 real test images
echo "Copying 10 test images..."
LATEST_DIR=$(ls -d ~/Pictures/raid/2025/* | sort -r | head -n 1)
find "$LATEST_DIR" -maxdepth 1 -type f \( -iname "*.jpg" -o -iname "*.arw" \) | head -n 10 | xargs -I {} cp {} "$TEST_DIR/"

# Run with --updatepreviews (No --testone to process all 10)
echo "Running test with --updatepreviews..."
./run.sh --library test.db --updatemd "$TEST_DIR" --updatepreviews --previewdb previews.db --longedge 1024 --longedge 300

# Check if db was created
if [ -f "test.db" ]; then
    echo "Success: Main Database created."
    
    echo "=========================================="
    echo "Dumping Table: RootPaths"
    echo "=========================================="
    sqlite3 -header -column test.db "SELECT * FROM RootPaths;"

    echo ""
    echo "=========================================="
    echo "Dumping Table: FileEntry (Count: $(sqlite3 test.db "SELECT count(*) FROM FileEntry;"))"
    echo "=========================================="
    sqlite3 -header -column test.db "SELECT * FROM FileEntry;"
else
    echo "Failure: Main Database not created."
fi

if [ -f "previews.db" ]; then
    echo ""
    echo "Success: Preview Database created."
    echo "=========================================="
    echo "Dumping Table: Previews (Count: $(sqlite3 previews.db "SELECT count(*) FROM Previews;"))"
    echo "=========================================="
    # Only show top 20 to avoid clutter, but show stats
    sqlite3 -header -column previews.db "SELECT FileId, LongEdge, length(Data) as SizeBytes FROM Previews LIMIT 20;"
else
    echo "Failure: Preview Database not created."
fi

if [ -f "test.db" ]; then
    echo ""
    echo "=========================================="
    echo "Dumping Table: Metadata (Sample)"
    echo "=========================================="
    sqlite3 -header -column test.db "SELECT * FROM Metadata LIMIT 20;"
fi