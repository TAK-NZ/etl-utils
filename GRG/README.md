# GRG Overlays

`grg_xxxx.xml` files are overlays that need to be manually copied to ATAK into the `atak/grg` folder.

## Installation

1. **Generate GRG files**:
   ```bash
   ./build-grg-files.sh utils.demo.tak.nz ./grg-output
   ```

2. **Copy to ATAK device**:
   - **Android**: `Internal storage/atak/grg/`

3. **Restart ATAK**

4. **Access overlays**: Map Layers menu

## Available Overlays

- `grg_global_weather_radar.xml` - Weather radar overlay
- `grg_openseamap.xml` - OpenSeaMap nautical overlay  
- `grg_Google_Road_Only_(Overlay).xml` - Google roads overlay