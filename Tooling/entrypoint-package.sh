#!/bin/bash
set -e

# This script runs inside the container
# Working directory is /src (mounted from host project root)

# 1. Build the project
echo "Building PhotoLibrary binary..."
./Tooling/buildAndPublish.sh

# Create a common desktop file for all packages
echo "Creating desktop file..."
cat > Tooling/photolibrary.desktop <<EOF
[Desktop Entry]
Name=PhotoLibrary
Exec=photolibrary
Icon=photolibrary
Type=Application
Categories=Graphics;
Terminal=false
EOF

# 2. Prepare AppDir for AppImage
echo "Preparing AppDir..."
rm -rf AppDir
mkdir -p AppDir/usr/bin
mkdir -p AppDir/usr/share/icons/hicolor/scalable/apps

cp dist/linux/PhotoLibrary AppDir/usr/bin/photolibrary
cp PhotoLibrary/wwwsrc/favicon.svg AppDir/usr/share/icons/hicolor/scalable/apps/photolibrary.svg
cp PhotoLibrary/wwwsrc/favicon.svg AppDir/photolibrary.svg
cp Tooling/photolibrary.desktop AppDir/photolibrary.desktop

# Create AppRun script for AppImage
echo "Creating AppRun..."
cat > AppDir/AppRun <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "${0}")")"
exec "${HERE}/usr/bin/photolibrary" "$@"
EOF
chmod +x AppDir/AppRun

# 3. Generate AppImage
echo "Generating AppImage..."
VERSION=$(cat Tooling/version.txt)
# Use correct architecture and silence some noisy warnings
APPIMAGE_FILENAME="PhotoLibrary-${VERSION}-x86_64.AppImage"
ARCH=x86_64 /usr/local/bin/appimagetool --appimage-extract-and-run AppDir "$APPIMAGE_FILENAME"

echo "Zipping AppImage..."
# Use standard AppImage naming convention for the zip as well, or keep deb style if preferred. 
# Switching to AppImage convention for consistency with the file inside.
ZIP_NAME="PhotoLibrary-${VERSION}-x86_64.AppImage.zip"
zip "$ZIP_NAME" "$APPIMAGE_FILENAME"

# 4. Generate DEB and RPM using nfpm
echo "Generating DEB package..."
nfpm pkg --packager deb --target . -f Tooling/nfpm.yaml

echo "Generating RPM package..."
nfpm pkg --packager rpm --target . -f Tooling/nfpm.yaml

# 5. Organize output
echo "Organizing output..."
mkdir -p dist/packages
mv *.AppImage dist/packages/
mv *.zip dist/packages/
mv *.deb dist/packages/
mv *.rpm dist/packages/

echo "Build successful. All packages are in dist/packages/"
