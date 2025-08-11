# TileServer GL API

MapTiler TileServer GL service providing vector and raster tile services for New Zealand topographic maps.

## Base URL

```
https://utils.{domain}/tiles
```

## Available Styles

### NZ Topo Lite
- **Style ID**: `topolite`
- **URL**: `/tiles/styles/topolite/style.json`
- **Tiles**: `/tiles/styles/topolite/{z}/{x}/{y}.png`

### NZ Topographic  
- **Style ID**: `topographic`
- **URL**: `/tiles/styles/topographic/style.json`
- **Tiles**: `/tiles/styles/topographic/{z}/{x}/{y}.png`

### NZ Emergency Management
- **Style ID**: `nationalmap`
- **URL**: `/tiles/styles/nationalmap/style.json`
- **Tiles**: `/tiles/styles/nationalmap/{z}/{x}/{y}.png`

### LINZ Topographic Raster
- **Style ID**: `linz-topo`
- **URL**: `/tiles/styles/linz-topo/style.json`
- **Tiles**: `/tiles/styles/linz-topo/{z}/{x}/{y}.png`

## Health Check

```
GET /tiles/health
```

Returns service health status.

## Configuration

The service uses LINZ Basemaps API for tile data. API keys are configured via S3:

### S3 Configuration File Format

```json
{
  "authkey": "your-linz-auth-key",
  "apikey": "your-linz-api-key"
}
```

### S3 Configuration Path

- **Bucket**: Environment config bucket from base infrastructure
- **Key**: `ETL-Util-TileServer-GL-Api-Keys.json`

## Usage Examples

### Get Style JSON
```bash
curl https://utils.example.com/tiles/styles/topolite/style.json
```

### Get Tile
```bash
curl https://utils.example.com/tiles/styles/topolite/6/63/39.png
```

### Health Check
```bash
curl https://utils.example.com/tiles/health
```

## Map Bounds

All styles are configured for New Zealand region:
- **Center**: [174.7763921, -41.2865302]
- **Bounds**: [166.0, -48.0, 179.0, -34.0]
- **Default Zoom**: 6