#!/bin/bash
set -e

# Ensure we are in the project root
cd "$(dirname "$0")/.."

# Build the Windows binary first
./Tooling/build-windows.sh

# Get version
if [ -f Tooling/version.txt ]; then
    VERSION=$(cat Tooling/version.txt)
else
    VERSION="1.0.0"
fi

echo "Creating Installer for Version: $VERSION"

# Define Output Directory
DIST_DIR_HOST="$(pwd)/dist/win-x64"
OUTPUT_DIR_HOST="$(pwd)/dist/installers"
mkdir -p "$OUTPUT_DIR_HOST"
chmod 777 "$OUTPUT_DIR_HOST"

# Pre-create the directory explicitly inside the mount path logic
# to ensure the container user can write to it
mkdir -p dist/installers

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
SetupIconFile=PhotoLibrary.WFE/wwwsrc/favicon.ico
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
Source: "PhotoLibrary.WFE/wwwsrc/favicon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\PhotoLibrary"; Filename: "{app}\PhotoLibrary.exe"; IconFilename: "{app}\favicon.ico"
Name: "{autodesktop}\PhotoLibrary"; Filename: "{app}\PhotoLibrary.exe"; Tasks: desktopicon; IconFilename: "{app}\favicon.ico"

[Run]
Filename: "{app}\PhotoLibrary.exe"; Description: "{cm:LaunchProgram,PhotoLibrary}"; Flags: nowait postinstall skipifsilent
EOF

echo "Running Inno Setup via Docker..."

# Build debug image
podman build -t photolibrary-installer -f Tooling/Dockerfile.installer .

# Run Inno Setup in Docker
# Mount current directory to /work with SELinux relabeling
podman run --rm -v "$(pwd):/work:Z" -w "/work" photolibrary-installer installer.iss

rm installer.iss

echo "Installer created at dist/installers/PhotoLibrary-Setup-$VERSION.exe"