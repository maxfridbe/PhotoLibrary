#!/bin/bash
# Check if test databases exist
if [ ! -f "test.db" ] || [ ! -f "previews.db" ]; then
    echo "Test databases not found. Running test.sh first to generate them..."
    ./test.sh
fi

echo "Starting web server on http://localhost:8080..."
echo "Press Ctrl+C to stop."

./run.sh --library test.db --previewdb previews.db --host 8080
