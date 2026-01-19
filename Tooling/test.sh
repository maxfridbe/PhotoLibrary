#!/bin/bash
cd "$(dirname "$0")/.."
# Setup test environment
rm -f Tooling/test.db Tooling/test.db-wal Tooling/test.db-shm Tooling/test_previews.db Tooling/test_previews.db-wal Tooling/test_previews.db-shm
TEST_DIR="./test_images"
# rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

RAID_BASE="$HOME/Pictures/raid"
TOTAL_NEEDED=100
COUNT=0

echo "Sampling up to 100 images (max 20 per folder, newest first)..."

# Iterate through recent years to find images quickly
for year in 2025 2024 2023 2022 2021; do
    YEAR_DIR="$RAID_BASE/$year"
    [ ! -d "$YEAR_DIR" ] && continue

    # Find subdirectories
    while read -r subdir; do
        [ "$COUNT" -ge "$TOTAL_NEEDED" ] && break 2
        
        # We use process substitution <(...) to avoid the subshell variable scope issue
        while read -r src; do
            [ -z "$src" ] && continue
            [ "$COUNT" -ge "$TOTAL_NEEDED" ] && break
            
            rel_path="${src#$RAID_BASE/}"
            dest="$TEST_DIR/$rel_path"
            
            if [ -f "$dest" ]; then
                ((COUNT++))
                # echo -ne "Existing: $COUNT/$TOTAL_NEEDED images skipped... \r"
                continue
            fi

            mkdir -p "$(dirname "$dest")"
            if cp "$src" "$dest" 2>/dev/null; then
                ((COUNT++))
                echo -ne "Progress: $COUNT/$TOTAL_NEEDED images copied... \r"
            fi
        done < <(ls -dt "$subdir"/* 2>/dev/null | grep -iE "\.(JPG|ARW|NEF|CR2|CR3|DNG|RAF|RW2|ORF)$")
        
    done < <(find "$YEAR_DIR" -maxdepth 2 -type d | sort -r)
done

echo -e "\nFinished copying $COUNT images to $TEST_DIR"

# Run with --updatepreviews
echo "Running scan and preview generation..."
./Tooling/run.sh --library Tooling/test.db --updatemd "$TEST_DIR" --updatepreviews --previewdb Tooling/test_previews.db --longedge 1024 --longedge 300

# Check if db was created
if [ -f "Tooling/test.db" ]; then
    echo "Success: Main Database created."
    echo "Total files in DB: $(sqlite3 Tooling/test.db "SELECT count(*) FROM FileEntry;")"
else
    echo "Failure: Main Database not created."
fi