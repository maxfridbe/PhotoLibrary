#!/bin/bash
# Ensure we are in the project root
cd "$(dirname "$0")/.."

echo "Cleaning .NET Solution..."
dotnet clean PhotoLibrary.sln -c Debug
dotnet clean PhotoLibrary.sln -c Release

echo "Removing build artifacts and temporary directories..."
rm -rf dist/
rm -rf AppDir/
rm -rf PhotoLibrary.WFE/wwwroot/
rm -rf PhotoLibrary.WFE/bin/
rm -rf PhotoLibrary.WFE/obj/
rm -rf PhotoLibrary/wwwroot/
rm -rf PhotoLibrary/bin/
rm -rf PhotoLibrary/obj/
rm -rf PhotoLibrary.Backend/bin/
rm -rf PhotoLibrary.Backend/obj/
rm -rf TypeGen/bin/
rm -rf TypeGen/obj/
rm -rf bin/
rm -rf obj/
rm -rf export/
rm -rf output/
rm -rf test_images/

# Remove temporary test databases if they exist in Tooling
rm -f Tooling/*.db Tooling/*.db-wal Tooling/*.db-shm

echo "Clean complete."
