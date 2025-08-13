# TileServer GL API

MapTiler TileServer GL service providing vector and raster tile services for New Zealand topographic maps with API key authentication.

## Base URL

```
https://tiles.{domain}
```

## Authentication

All endpoints except `/health` require an API key parameter:

```
?api=your-api-key-here
```

## Available Styles

### NZ Topo Lite
- **Style ID**: `topolite`
- **URL**: `/styles/topolite/style.json?api=your-key`
- **Tiles**: `/styles/topolite/{z}/{x}/{y}.png?api=your-key`

### NZ Topographic  
- **Style ID**: `topographic`
- **URL**: `/styles/topographic/style.json?api=your-key`
- **Tiles**: `/styles/topographic/{z}/{x}/{y}.png?api=your-key`

### NZ Emergency Management
- **Style ID**: `nationalmap`
- **URL**: `/styles/nationalmap/style.json?api=your-key`
- **Tiles**: `/styles/nationalmap/{z}/{x}/{y}.png?api=your-key`

### LINZ Topographic Raster
- **Style ID**: `linz-topo`
- **URL**: `/styles/linz-topo/style.json?api=your-key`
- **Tiles**: `/styles/linz-topo/{z}/{x}/{y}.png?api=your-key`

## Health Check

```
GET /health
```

Returns service health status. **No API key required.**

## Configuration

The service uses LINZ Basemaps API for tile data and requires API key authentication.

### API Key Authentication

**CloudFront Function**: Validates API keys at the edge for `/styles/*` paths only

**Excluded Files** (no authentication required):
- `/styles/topolite/12/4036/2564.png`
- `/styles/linz-topo/12/4036/2564.png` 
- `/styles/topographic/12/4036/2564.png`
- `/styles/nationalmap/12/4036/2564.png`

**Configuration**: API keys managed via CDK context or defaults

### Backend API Configuration (S3)

```json
{
  "authkey": "your-nz-emergency-management-auth-key",
  "apikey": "your-linz-api-key"
}
```

**Path**: `ETL-Util-TileServer-GL-Api-Keys.json`

- `authkey`: NZ Emergency Management API credentials
- `apikey`: LINZ Basemaps API credentials

## Usage Examples

### Get Style JSON (requires API key)
```bash
curl "https://tiles.example.com/styles/topolite/style.json?api=your-api-key"
```

### Get Tile (requires API key)
```bash
curl "https://tiles.example.com/styles/topolite/6/63/39.png?api=your-api-key"
```

### Get Excluded Tile (no API key required)
```bash
curl "https://tiles.example.com/styles/topolite/12/4036/2564.png"
```

### Health Check
```bash
curl https://tiles.example.com/health
```

## Error Responses

### Missing API Key
```json
{
  "error": "API key required"
}
```
**Status**: 401 Unauthorized

### Invalid API Key
```json
{
  "error": "Invalid API key"
}
```
**Status**: 403 Forbidden

## Map Bounds

All styles are configured for New Zealand region:
- **Center**: [174.7763921, -41.2865302]
- **Bounds**: [166.0, -48.0, 179.0, -34.0]
- **Default Zoom**: 6