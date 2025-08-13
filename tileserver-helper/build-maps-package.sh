#!/bin/bash

# Build TAK Server Maps Package
# Usage: ./build-maps-package.sh <domain> <api-key> [output-dir]

set -e

# Check arguments
if [ $# -lt 2 ]; then
    echo "Usage: $0 <domain> <api-key> [output-dir]"
    echo "Example: $0 example.com tk_abc123 ./output"
    exit 1
fi

DOMAIN="$1"
API_KEY="$2"
OUTPUT_DIR="${3:-./output}"

# Generate new UUID
UUID=$(uuidgen)

# Create output directory and get absolute paths
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(realpath "$OUTPUT_DIR")
TEMP_DIR=$(mktemp -d)

echo "Building TAK Maps Package..."
echo "Domain: $DOMAIN"
echo "API Key: ${API_KEY:0:10}..."
echo "UUID: $UUID"

# Get script directory and copy template files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -r "$SCRIPT_DIR/maps-package/template/"* "$TEMP_DIR/"

# Replace template variables in all XML files
find "$TEMP_DIR" -name "*.xml" -type f -exec sed -i "s/{{DOMAIN}}/$DOMAIN/g" {} \;
find "$TEMP_DIR" -name "*.xml" -type f -exec sed -i "s/{{API_KEY}}/$API_KEY/g" {} \;
find "$TEMP_DIR" -name "*.xml" -type f -exec sed -i "s/{{UUID}}/$UUID/g" {} \;

# Create zip file in temp directory then move to output
cd "$TEMP_DIR"
zip -r "TAK-NZ-Maps-Package.zip" ./*

# Move to output directory
OUTPUT_PATH="$OUTPUT_DIR/TAK-NZ-Maps-Package.zip"
mv "TAK-NZ-Maps-Package.zip" "$OUTPUT_PATH"

# Verify file was created
if [ -f "$OUTPUT_PATH" ]; then
    echo "✅ Maps package created: $OUTPUT_PATH"
    ls -la "$OUTPUT_PATH"
else
    echo "❌ Failed to create maps package at: $OUTPUT_PATH"
    exit 1
fi

# Cleanup
rm -rf "$TEMP_DIR"