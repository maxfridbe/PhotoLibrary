#!/bin/bash
set -e

# Format: Major.YY.MMDD.Minor
# Example: 1.26.0119.0

# Ensure we are in the directory where version.txt is
cd "$(dirname "$0")"

YY=$(date +"%y")
MMDD=$(date +"%m%d")
REPO="maxfridbe/PhotoLibrary"

# Get Major from current version or first argument
CURRENT_VERSION=$(cat version.txt)
MAJOR=$(echo "$CURRENT_VERSION" | cut -d. -f1)

if [ ! -z "$1" ]; then
    MAJOR="$1"
fi

PREFIX="${MAJOR}.${YY}.${MMDD}."
echo "Checking GitHub for existing versions with prefix: $PREFIX"

# Fetch tags from GitHub API and extract minors for today's prefix
# Matches v1.26.0119.0, 1.26.0119.0, v1.26.0119.0-functional, etc.
EXISTING_MINORS=$(curl -s "https://api.github.com/repos/$REPO/tags" | grep -oP "\"name\": \"v?${PREFIX}\K[0-9]+" || true)

if [ -z "$EXISTING_MINORS" ]; then
    echo "No releases found for today. Starting at minor 0."
    MINOR=0
else
    LATEST_MINOR=$(echo "$EXISTING_MINORS" | sort -n | tail -1)
    MINOR=$((LATEST_MINOR + 1))
    echo "Found existing releases. Next minor: $MINOR"
fi

NEW_VERSION="${PREFIX}${MINOR}"

echo "$NEW_VERSION" > version.txt
echo "Updated version to $NEW_VERSION"