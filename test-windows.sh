#!/bin/bash
set -e

EXE_PATH="dist/win-x64/PhotoLibrary.exe"

if ! command -v wine &> /dev/null; then
    echo "Wine is not installed. Skipping test."
    exit 0
fi

if [ ! -f "$EXE_PATH" ]; then
    echo "Executable not found: $EXE_PATH"
    exit 1
fi

echo "Starting PhotoLibrary.exe with Wine..."
# Run in background, redirect logs. Use in-memory DBs to avoid creating files.
# Port 8081 to avoid conflict if dev server running? Default 8080.
PORT=8081
export DOTNET_gcServer=0
wine "$EXE_PATH" --library ":memory:" --previewdb ":memory:" --host $PORT > wine.log 2>&1 &
PID=$!

echo "Waiting for server to start on port $PORT..."
MAX_RETRIES=30
COUNT=0
SUCCESS=0

while [ $COUNT -lt $MAX_RETRIES ]; do
    # Check if process is still running
    if ! kill -0 $PID 2>/dev/null; then
        echo "Process died prematurely."
        break
    fi

    if curl -s http://localhost:$PORT/index.html | grep -q "Photo Library"; then
        echo "Success: index.html is reachable!"
        SUCCESS=1
        break
    fi
    sleep 1
    COUNT=$((COUNT+1))
    echo -n "."
done

echo ""

# Cleanup
echo "Killing process $PID..."
kill $PID || true
# Ensure wine processes are cleaned up if possible, but basic kill is usually enough for test wrapper

if [ $SUCCESS -eq 1 ]; then
    echo "Test PASSED."
    rm wine.log
    exit 0
else
    echo "Test FAILED. Server did not respond."
    echo "Logs (wine.log):"
    cat wine.log
    exit 1
fi
