#!/bin/bash
echo "Cleaning wwwroot..."
rm -rf wwwroot/*
echo "Publishing self-contained single file executable..."
dotnet publish -c Release -r linux-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist
echo "Done. Executable is in ./dist/PhotoLibrary"
