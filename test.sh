#!/bin/bash
# Setup test environment
TEST_DIR="./test_images"
mkdir -p "$TEST_DIR"
echo "dummy content" > "$TEST_DIR/test1.txt"

# Run with --testone
echo "Running test with --testone..."
./run.sh --library test.db --updatemd "$TEST_DIR" --testone

# Check if db was created
if [ -f "test.db" ]; then
    echo "Success: Database created."
else
    echo "Failure: Database not created."
fi

# Clean up (optional, keep for inspection)
# rm -rf "$TEST_DIR" test.db
