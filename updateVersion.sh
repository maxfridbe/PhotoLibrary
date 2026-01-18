#!/bin/bash
set -e

# Format: Major.Minor.YY.MMDD where Major.Minor is manually controlled, and YY.MMDD is automatic.
# Example: 1.2.26.0118

DATE_PART=$(date +"%y.%m%d")
CURRENT_VERSION=$(cat version.txt)
CURRENT_MAJOR=$(echo "$CURRENT_VERSION" | cut -d. -f1-2)

NEW_MAJOR="$1"

if [ -z "$NEW_MAJOR" ]; then
    NEW_MAJOR="$CURRENT_MAJOR"
fi

NEW_VERSION="${NEW_MAJOR}.${DATE_PART}"

echo "$NEW_VERSION" > version.txt
echo "Updated version to $NEW_VERSION"
