#!/usr/bin/env python3
import requests
import math
import sqlite3
import os
from tqdm import tqdm
import time
import argparse
import subprocess
import random
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
import queue

def deg2num(lat_deg, lon_deg, zoom):
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return (xtile, ytile)

def download_wms_tile(zoom, x, y, auth_key, max_retries=5):
    # Calculate bbox for tile
    n = 2.0 ** zoom
    lon_deg_min = x / n * 360.0 - 180.0
    lat_deg_max = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lon_deg_max = (x + 1) / n * 360.0 - 180.0
    lat_deg_min = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    
    # Convert to EPSG:3857 (Web Mercator)
    def deg_to_mercator(lon, lat):
        x_merc = lon * 20037508.34 / 180
        y_merc = math.log(math.tan((90 + lat) * math.pi / 360)) / (math.pi / 180) * 20037508.34 / 180
        return x_merc, y_merc
    
    x_min, y_min = deg_to_mercator(lon_deg_min, lat_deg_min)
    x_max, y_max = deg_to_mercator(lon_deg_max, lat_deg_max)
    
    bbox = f"{x_min},{y_min},{x_max},{y_max}"
    
    url = f"https://maps.nationalmap.co.nz/wms?authkey={auth_key}&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=NationalMap:NationalMap%20Emergency%20Management&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox}"
    
    for attempt in range(max_retries):
        try:
            response = requests.get(url, timeout=30)
            if response.status_code == 200 and len(response.content) > 0:
                return response.content
            elif response.status_code == 429:  # Rate limited
                wait_time = (2 ** attempt) + random.uniform(0, 1)
                print(f"Rate limited, waiting {wait_time:.1f}s before retry {attempt+1}/{max_retries}")
                time.sleep(wait_time)
                continue
            else:
                print(f"HTTP {response.status_code} for tile z:{zoom} x:{x} y:{y}")
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            wait_time = (2 ** attempt) + random.uniform(0, 1)
            print(f"Network error for tile z:{zoom} x:{x} y:{y}, retry {attempt+1}/{max_retries} in {wait_time:.1f}s")
            if attempt < max_retries - 1:
                time.sleep(wait_time)
        except Exception as e:
            print(f"Error downloading tile z:{zoom} x:{x} y:{y}: {e}")
            break
    
    return None

def create_nationalmap_mbtiles(auth_key, min_zoom=0, max_zoom=15):
    # Wide bounds for zoom 1-9 (includes Chatham Islands and full coverage)
    wide_bounds = {
        'min_lat': -56.33,   # Official WMS minimum
        'max_lat': -25.19,   # Official WMS maximum
        'min_lon': -180.0,   # Includes Chatham Islands
        'max_lon': 180.0     # Full dateline coverage
    }

    # Narrow bounds for zoom 10+ (main NZ landmass)
    narrow_bounds = {
        'min_lat': -47.5,  # Covers Stewart Island plus buffer
        'max_lat': -34.0,  # Covers North Cape plus buffer
        'min_lon': 166.0,  # Covers West Coast plus buffer
        'max_lon': 179.0   # Covers East Cape plus buffer
    }
    
    output_file = "nz_nationalmap_emergency.mbtiles"
    
    # Check if resuming existing download
    resuming = os.path.exists(output_file)
    if resuming:
        print(f"Resuming existing download: {output_file}")
    else:
        print(f"Starting new download: {output_file}")
    
    conn = sqlite3.connect(output_file)
    c = conn.cursor()
    
    if not resuming:
        c.execute('''CREATE TABLE metadata (name text, value text)''')
        c.execute('''CREATE TABLE tiles (zoom_level integer, tile_column integer, 
                                       tile_row integer, tile_data blob)''')
        c.execute('CREATE UNIQUE INDEX tile_index on tiles (zoom_level, tile_column, tile_row)')
    
    # Function to check if tile exists
    def tile_exists(zoom, x, y):
        tms_y = (2**zoom - 1) - y
        c.execute('SELECT 1 FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?', 
                 (zoom, x, tms_y))
        return c.fetchone() is not None

    if not resuming:
        metadata = [
            ("name", "NZ Emergency Management"),
            ("type", "baselayer"),
            ("version", "1.0.0"),
            ("description", "National Map Emergency Management"),
            ("format", "png"),
            ("bounds", f"{narrow_bounds['min_lon']},{narrow_bounds['min_lat']},{narrow_bounds['max_lon']},{narrow_bounds['max_lat']}"),
            ("center", "173.0,-41.0,6"),
            ("minzoom", str(min_zoom)),
            ("maxzoom", str(max_zoom)),
            ("attribution", "© NationalMap WMS Basemap Service CC BY-NC-ND 4.0")
        ]
        
        for name, value in metadata:
            c.execute('INSERT INTO metadata VALUES (?, ?)', (name, value))
    
    total_tiles_processed = 0
    
    for zoom in range(min_zoom, max_zoom + 1):
        print(f"\nProcessing zoom level {zoom}")
        
        # Use wide bounds for zoom 1-9, narrow bounds for zoom 10+
        current_bounds = wide_bounds if 1 <= zoom <= 9 else narrow_bounds
        print(f"Using {'wide' if current_bounds == wide_bounds else 'narrow'} bounds for zoom {zoom}")
        
        x_min, y_max = deg2num(current_bounds['min_lat'], current_bounds['min_lon'], zoom)
        x_max, y_min = deg2num(current_bounds['max_lat'], current_bounds['max_lon'], zoom)
        
        x_min = max(0, x_min)
        x_max = min(2**zoom - 1, x_max)
        y_min = max(0, y_min)
        y_max = min(2**zoom - 1, y_max)
        
        # Create tile list for parallel processing (skip existing tiles)
        tile_list = []
        existing_count = 0
        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                if tile_exists(zoom, x, y):
                    existing_count += 1
                else:
                    tile_list.append((zoom, x, y, auth_key))
        
        total_tiles_in_bounds = (x_max - x_min + 1) * (y_max - y_min + 1)
        tiles_to_download = len(tile_list)
        
        if existing_count > 0:
            print(f"Skipping {existing_count} existing tiles for zoom {zoom}")
        
        print(f"Downloading {tiles_to_download} tiles for zoom level {zoom}")
        
        if tiles_to_download == 0:
            print(f"All tiles already exist for zoom {zoom}")
            continue
        
        successful_tiles = 0
        tile_queue = []
        queue_lock = threading.Lock()
        
        def download_tile_worker(tile_args):
            z, x, y, key = tile_args
            tile_data = download_wms_tile(z, x, y, key)
            if tile_data:
                tms_y = (2**z - 1) - y
                with queue_lock:
                    tile_queue.append((z, x, tms_y, tile_data))
                return True
            return False
        
        with ThreadPoolExecutor(max_workers=3) as executor:
            with tqdm(total=tiles_to_download, desc=f"Zoom {zoom}") as pbar:
                futures = [executor.submit(download_tile_worker, tile) for tile in tile_list]
                
                for future in as_completed(futures):
                    if future.result():
                        successful_tiles += 1
                    pbar.update(1)
                    
                    # Process queued tiles in main thread
                    with queue_lock:
                        while tile_queue:
                            z, x, tms_y, tile_data = tile_queue.pop(0)
                            try:
                                c.execute("INSERT INTO tiles VALUES (?, ?, ?, ?)",
                                        (z, x, tms_y, sqlite3.Binary(tile_data)))
                            except sqlite3.IntegrityError:
                                print(f"Duplicate tile: z:{z} x:{x} y:{tms_y}")
                    
                    if pbar.n % 10 == 0:  # Commit every 10 tiles
                        conn.commit()
                    
                    # No delay - rely on retries and backoff
        
        total_tiles_processed += successful_tiles
        print(f"Successfully downloaded {successful_tiles} tiles for zoom level {zoom}")
    
    print(f"\nTotal tiles processed: {total_tiles_processed}")
    conn.close()
    print(f"Created {output_file}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Create MBTiles for NZ Emergency Management WMS')
    parser.add_argument('--auth-key', required=True, help='NationalMap WMS auth key')
    parser.add_argument('--min-zoom', type=int, default=0, help='Minimum zoom level')
    parser.add_argument('--max-zoom', type=int, default=15, help='Maximum zoom level')
    
    args = parser.parse_args()
    
    print(f"Creating Emergency Management tiles...")
    print(f"Zoom levels: {args.min_zoom} to {args.max_zoom}")
    
    create_nationalmap_mbtiles(args.auth_key, args.min_zoom, args.max_zoom)
