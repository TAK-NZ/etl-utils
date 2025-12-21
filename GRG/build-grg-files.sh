#!/bin/bash

# Build GRG XML Files for Manual ATAK Installation
# Usage: ./build-grg-files.sh <domain> [output-dir]

set -e

# Check arguments
if [ $# -lt 1 ]; then
    echo "Usage: $0 <domain> [output-dir]"
    echo "Example: $0 utils.demo.tak.nz ./grg-output"
    echo ""
    echo "Generated files should be manually copied to:"
    echo "  Android: Internal storage/atak/grg/"
    exit 1
fi

DOMAIN="$1"
OUTPUT_DIR="${2:-./grg-output}"

# Create output directory
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(realpath "$OUTPUT_DIR")

echo "Building GRG XML Files..."
echo "Domain: $DOMAIN"
echo "Output: $OUTPUT_DIR"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Copy and process each template
for template in "$SCRIPT_DIR/templates/"*.xml; do
    filename=$(basename "$template")
    echo "Processing: $filename"
    
    # Replace domain placeholder and copy to output
    sed "s/{{DOMAIN}}/$DOMAIN/g" "$template" > "$OUTPUT_DIR/$filename"
done

echo ""
echo "✅ GRG files created in: $OUTPUT_DIR"
echo ""
echo "Manual Installation Instructions:"
echo "1. Copy XML files to ATAK device:"
echo "   Android: Internal storage/atak/grg/"
echo "2. Restart ATAK"
echo "3. Overlays will appear in Map Layers menu"

ls -la "$OUTPUT_DIR"