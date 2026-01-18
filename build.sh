#!/bin/bash
VERSION=$(cat version.txt)
echo "export const APP_VERSION = '$VERSION';" > PhotoLibrary/wwwsrc/version.ts
dotnet build
