#!/bin/bash
cd "$(dirname "$0")/.."
VERSION=$(cat Tooling/version.txt)
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "export const APP_VERSION = '$VERSION';" > PhotoLibrary/wwwsrc/version.ts
echo "export const BUILD_DATE = '$BUILD_DATE';" >> PhotoLibrary/wwwsrc/version.ts
dotnet build PhotoLibrary.sln /p:BuildMetadata="+$BUILD_DATE"