# NationalMap Tile Download Monitoring Guide

## Quick Status Check

```bash
# Check if download is running
ps -p $(cat nationalmap_download.pid) && echo "Running" || echo "Stopped"

# Current zoom level
grep "Processing zoom level" nationalmap_download.log | tail -1

# File size
ls -lh nz_nationalmap_emergency.mbtiles
```

## Live Progress Monitoring

```bash
# Watch live output
tail -f nationalmap_download.log

# Watch file size growth (updates every 5 minutes)
watch -n 300 'ls -lh *.mbtiles'

# Monitor system resources
htop
```

## Progress Analysis

```bash
# See all completed zoom levels
grep "Successfully downloaded" nationalmap_download.log

# Count total tiles downloaded so far
grep "Successfully downloaded" nationalmap_download.log | awk '{sum += $3} END {print "Total tiles:", sum}'

# Check for errors
grep -c "Error downloading" nationalmap_download.log
grep -c "Rate limited" nationalmap_download.log
grep -c "Network error" nationalmap_download.log

# Last 20 log entries
tail -20 nationalmap_download.log
```

## Expected Timeline

| Zoom Level | Tiles | Expected Duration |
|------------|-------|-------------------|
| 0-9        | ~1,400 | Few seconds |
| 10         | ~5,600 | 10-30 minutes |
| 11         | ~22,400 | 30-60 minutes |
| 12         | ~89,600 | 1-2 hours |
| 13         | ~358,400 | 4-8 hours |
| 14         | ~1.4M | 1-2 days |
| 15         | ~5.6M | 4-8 days |

**Total Estimate: 5-10 days**

## Control Commands

```bash
# Stop download
kill $(cat nationalmap_download.pid)

# Resume download (automatically resumes from where it left off)
./download_nationalmap.sh

# Check disk space
df -h .

# Estimate completion time (rough)
echo "Current file size: $(ls -lh nz_nationalmap_emergency.mbtiles | awk '{print $5}')"
echo "Expected final size: ~50-100GB"
```

## Troubleshooting

### If download stops unexpectedly:
```bash
# Check what happened
tail -50 nationalmap_download.log

# Resume download
./download_nationalmap.sh
```

### If running out of disk space:
```bash
# Check available space
df -h .

# If needed, move to larger disk or reduce max zoom level
```

### If too many errors:
```bash
# Count error types
grep "Error downloading" nationalmap_download.log | wc -l
grep "Rate limited" nationalmap_download.log | wc -l

# If >10% error rate, consider stopping and investigating
```

## Performance Indicators

**Good performance:**
- Zoom levels 0-12 complete in < 3 hours
- File grows steadily (check every few hours)
- Error rate < 5%

**Slow performance:**
- Zoom 13+ taking much longer than expected
- Many "Rate limited" messages
- File size not growing

## Key Milestones

- **Zoom 12 complete**: ~100MB file, 1-3 hours
- **Zoom 13 complete**: ~500MB file, 8-12 hours  
- **Zoom 14 complete**: ~5GB file, 2-3 days
- **Zoom 15 complete**: ~50GB file, 5-10 days

## Final Steps

Once download completes:
```bash
# Convert to PMTiles for serving
pmtiles convert nz_nationalmap_emergency.mbtiles nz_nationalmap_emergency.pmtiles

# Check final file sizes
ls -lh nz_nationalmap_emergency.*
```