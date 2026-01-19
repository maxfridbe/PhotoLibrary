#!/bin/bash
set -e

# Ensure we are in the project root
cd "$(dirname "$0")/.."

echo "Starting Full Build Process..."

# 1. Clean
echo "Step 1: Cleaning..."
./Tooling/clean.sh

# 2. Windows Build & Installer
echo "Step 2: Building Windows Binary and Installer..."
./Tooling/publish-windows-installer.sh

# 3. Linux Build
echo "Step 3: Building Linux Binary..."
./Tooling/buildAndPublish.sh

# 4. Package Linux Binary (Zip)
echo "Step 4: Packaging Linux Binary (Zip)..."
VERSION=$(cat Tooling/version.txt)
mkdir -p PhotoLibrary-linux-x64
cp dist/linux/PhotoLibrary PhotoLibrary-linux-x64/
zip -r PhotoLibrary-linux-x64-v$VERSION.zip PhotoLibrary-linux-x64/
mv PhotoLibrary-linux-x64-v$VERSION.zip dist/
rm -rf PhotoLibrary-linux-x64

# 5. Build OS Packages (AppImage, RPM, DEB)
echo "Step 5: Building Linux OS Packages (AppImage, RPM, DEB)..."
./Tooling/make_appimage_rpm_deb.sh

echo ""
echo "Full Build Complete!"
echo "--------------------------------"
echo "Windows Installer:  dist/installers/"
echo "Linux Binary (Zip): dist/PhotoLibrary-linux-x64-v$VERSION.zip"
echo "Linux OS Packages:  dist/packages/"
echo "--------------------------------"
