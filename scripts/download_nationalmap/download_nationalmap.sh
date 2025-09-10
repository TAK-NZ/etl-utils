#!/bin/bash

# NationalMap Emergency Management Tile Downloader
# Downloads tiles in background with resume capability

AUTH_KEY="YOUR_NATIONALMAP_AUTH_KEY_HERE"
MAX_ZOOM=15
LOG_FILE="nationalmap_download.log"
PID_FILE="nationalmap_download.pid"

echo "=== NationalMap Emergency Management Tile Downloader ==="
echo "Auth Key: $AUTH_KEY"
echo "Max Zoom: $MAX_ZOOM"
echo "Log File: $LOG_FILE"
echo ""

# Check if already running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Download already running with PID $PID"
        echo "To monitor: tail -f $LOG_FILE"
        echo "To stop: kill $PID"
        exit 1
    else
        echo "Removing stale PID file"
        rm "$PID_FILE"
    fi
fi

# Start download in background
echo "Starting download in background..."
nohup ./create_nationalmap_mbtiles.py --auth-key "$AUTH_KEY" --max-zoom "$MAX_ZOOM" > "$LOG_FILE" 2>&1 &
PID=$!

# Save PID
echo $PID > "$PID_FILE"

echo "Download started with PID $PID"
echo ""
echo "Commands to monitor progress:"
echo "  tail -f $LOG_FILE          # Watch live progress"
echo "  tail -20 $LOG_FILE         # Check last 20 lines"
echo "  grep 'Processing zoom' $LOG_FILE  # See zoom progress"
echo "  ls -lh *.mbtiles           # Check file size"
echo ""
echo "Commands to control:"
echo "  kill $PID                  # Stop download"
echo "  ./download_nationalmap.sh  # Resume if stopped"
echo ""
echo "The download will continue even if you disconnect from SSH."
echo "Run this script again to resume if the process stops."
