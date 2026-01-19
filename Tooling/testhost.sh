#!/bin/bash
cd "$(dirname "$0")/.."
# Check if test databases exist
if [ ! -f "Tooling/test.db" ] || [ ! -f "Tooling/test_previews.db" ]; then
    echo "Test databases not found. Running test.sh first to generate them..."
    ./Tooling/test.sh
fi

echo "Starting web server on http://localhost:8080..."
echo "Press Ctrl+C to stop."

./Tooling/run.sh --library Tooling/test.db --previewdb Tooling/test_previews.db --host 8080