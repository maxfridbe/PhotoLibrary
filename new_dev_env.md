# Development Environment Setup (Debian)

This guide provides instructions for setting up the development environment for PhotoLibrary on a Debian-based system.

## 1. Install .NET 10 SDK

The project targets .NET 10.0.

```bash
# Add Microsoft package repository
wget https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -O packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb
rm packages-microsoft-prod.deb

# Install SDK
sudo apt-get update
sudo apt-get install -y dotnet-sdk-10.0
```

## 2. Install Node.js and TypeScript

Node.js is required for frontend development, and the TypeScript compiler (`tsc`) is used to compile the application's scripts.

```bash
# Install Node.js (Version 20+)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Install TypeScript globally (using the latest dev version for TypeScript 6)
sudo npm install -g typescript@next
```

## 3. Install Podman (for Packaging)

The Linux packaging pipeline (AppImage, RPM, DEB) uses Podman to ensure a consistent build environment.

```bash
sudo apt-get update
sudo apt-get install -y podman
```

## 4. Install Build Dependencies (Optional, for local packaging)

If you wish to run the packaging tools locally (without Podman), you will need the following:

```bash
sudo apt-get install -y libfuse2 file wget binutils zip rpm
```

## 5. Build and Run

After installing the dependencies, you can build and run the project:

```bash
# Fast local build
./Tooling/build.sh

# Run the application
./Tooling/run.sh
```

## 6. Troubleshooting

### `tsc` Command Not Found
If `dotnet build` fails with `MSB3073: The command "tsc" exited with code 127`, ensure that TypeScript is installed globally and `tsc` is in your `PATH`.

```bash
sudo npm install -g typescript
```

### Framework Version Mismatch
If you see an error about `net8.0` not being found, ensure you have updated the project to target `net10.0` or have the .NET 8 runtime installed. (The current codebase has been updated to .NET 10).
