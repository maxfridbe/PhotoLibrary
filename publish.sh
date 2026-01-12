#!/bin/bash
echo "Cleaning wwwroot..."
rm -rf wwwroot/*

# Linux x64
echo "Publishing for Linux (x64)..."
dotnet publish -c Release -r linux-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist/linux

# Windows x64
echo "Publishing for Windows (x64)..."
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist/windows

# macOS x64 (Intel)
echo "Publishing for macOS (Intel x64)..."
dotnet publish -c Release -r osx-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist/macos-x64

# macOS arm64 (Apple Silicon)
echo "Publishing for macOS (Apple Silicon arm64)..."
dotnet publish -c Release -r osx-arm64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist/macos-arm64

echo "Done. Executables are in ./dist/"