#!/bin/bash
set -e

# Ensure we are in the project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR/.."

# 1. Read the current version
VERSION=$(cat Tooling/version.txt | xargs)
TAG_NAME="v$VERSION-functional"

echo "Preparing to tag release: $TAG_NAME"

# 2. Check for uncommitted changes
if [[ -n $(git status -s) ]]; then
    echo "Error: You have uncommitted changes. Please commit or stash them before tagging."
    exit 1
fi

# 3. Check if tag already exists
if git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
    echo "Error: Tag $TAG_NAME already exists."
    exit 1
fi

# 4. Create annotated tag
echo "Creating tag $TAG_NAME..."
git tag -a "$TAG_NAME" -m "Functional release version $VERSION"

# 5. Push to origin
echo "Pushing changes and tags to origin..."
git push origin main
git push origin "$TAG_NAME"

echo "------------------------------------------------"
echo "Success! Tag $TAG_NAME has been created and pushed."
echo "GitHub Actions should now begin the release build."
echo "------------------------------------------------"
