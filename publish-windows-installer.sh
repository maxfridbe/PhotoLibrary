#!/bin/bash
set -e

# Build the Windows binary first
./build-windows.sh

# Get version
if [ -f version.txt ]; then
    VERSION=$(cat version.txt)
else
    VERSION="1.0.0"
fi

echo "Creating Installer for Version: $VERSION"

# Define Output Directory
DIST_DIR_HOST="$(pwd)/dist/win-x64"
OUTPUT_DIR_HOST="$(pwd)/dist/installers"
mkdir -p "$OUTPUT_DIR_HOST"
chmod 777 "$OUTPUT_DIR_HOST"

# Paths inside the container
DIST_DIR_CONTAINER="dist/win-x64"
OUTPUT_DIR_CONTAINER="dist/installers"

# Generate Inno Setup Script
cat > installer.iss <<EOF
[Setup]
AppId={{D81329C0-1234-4567-89AB-CDEF01234567}
AppName=PhotoLibrary
AppVersion=$VERSION
AppVerName=PhotoLibrary $VERSION
AppPublisher=TechHurts
AppPublisherURL=https://github.com/maxfridbe/PhotoLibrary
DefaultDirName={autopf}\PhotoLibrary
DefaultGroupName=PhotoLibrary
AllowNoIcons=yes
OutputDir=$OUTPUT_DIR_CONTAINER
OutputBaseFilename=PhotoLibrary-Setup-$VERSION
Compression=lzma
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "$DIST_DIR_CONTAINER/PhotoLibrary.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\PhotoLibrary"; Filename: "{app}\PhotoLibrary.exe"
Name: "{autodesktop}\PhotoLibrary"; Filename: "{app}\PhotoLibrary.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\PhotoLibrary.exe"; Description: "{cm:LaunchProgram,PhotoLibrary}"; Flags: nowait postinstall skipifsilent
EOF

echo "Running Inno Setup via Docker..."

# Build debug image
podman build -t photolibrary-installer -f Dockerfile.installer .

# Run Inno Setup in Docker
# Mount current directory to /work with SELinux relabeling
podman run --rm -v "$(pwd):/work:Z" -w "/work" photolibrary-installer installer.iss

echo "Installer created at dist/installers/PhotoLibrary-Setup-$VERSION.exe"
