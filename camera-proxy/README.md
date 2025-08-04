# Camera Proxy Service

Converts static camera images into HLS video streams by downloading images at regular intervals and generating live video segments. Streams start automatically when accessed - no need to create them explicitly.

## Features

- On-demand streaming - streams start when first accessed
- Downloads images from configured URLs every 10 seconds
- Generates HLS video streams using FFmpeg
- Domain whitelist validation via S3 configuration
- Automatic cleanup of inactive streams (5 minutes)
- Rate limiting and stream management

## API Endpoints

### Get HLS Playlist (Primary Method)
```
GET /camera-proxy/stream/playlist.m3u8?url=https://www.trafficnz.info/camera/628.jpg
```

### Get Video Segment
```
GET /camera-proxy/stream/{segment.ts}?url=https://www.trafficnz.info/camera/628.jpg
```

### List Active Streams
```
GET /camera-proxy/streams
```

### Health Check
```
GET /camera-proxy/health
```

## Configuration

The service uses an S3 configuration file to manage allowed domains:

```json
{
  "allowedDomains": [
    "trafficnz.info",
    "www.trafficnz.info",
    "example.com"
  ]
}
```

## Environment Variables

- `CONFIG_BUCKET` - S3 bucket containing configuration
- `CONFIG_KEY` - S3 key for configuration file (default: ETL-Util-Camera-Proxy-Config.json)
- `PORT` - Server port (default: 3000)
- `DEBUG` - Enable debug logging (default: false)

## Usage Example

```bash
# Play stream directly (starts automatically)
ffplay "http://localhost:3000/camera-proxy/stream/playlist.m3u8?url=https://www.trafficnz.info/camera/628.jpg"

# Or in a web player
<video controls>
  <source src="/camera-proxy/stream/playlist.m3u8?url=https://www.trafficnz.info/camera/628.jpg" type="application/vnd.apple.mpegurl">
</video>
```

## Technical Details

- Images are downloaded every 10 seconds
- HLS segments are 10 seconds each
- Playlist maintains 6 segments (1 minute of video)
- Inactive streams are cleaned up after 5 minutes of no access
- Streams start automatically when playlist is first requested
- Rate limited to 60 requests per minute per IP