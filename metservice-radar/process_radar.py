import cv2
import numpy as np
import requests
import os
import subprocess
import boto3
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

# Configuration
OUTPUT_FOLDER = "/tmp/radar"
TILES_FOLDER = "/tmp/tiles"
S3_BUCKET = os.environ.get('TILES_BUCKET')
S3_PREFIX = "metservice-radar"

# Regions with GCPs
REGIONS = {
    "northland": {
        "url": "https://www.metservice.com/publicData/rainRadar/image/northland/300K/",
        "gcps": [("396.625", "454.01", "172.6824", "-34.4240"), ("666.125", "904.84", "174.1669", "-36.4440"), ("910.625", "844.13", "175.5052", "-36.1731"), ("1074.5", "1169.45", "176.4147", "-37.6039")]
    },
    "auckland": {
        "url": "https://www.metservice.com/publicData/rainRadar/image/auckland/300K/",
        "gcps": [("744.125", "572.80", "175.5055", "-36.1724"), ("238.625", "187.14", "172.6844", "-34.4243"), ("907.5", "892.05", "176.4205", "-37.6063"), ("795.625", "1159.42", "175.7908", "-38.7781")]
    },
    "bay-of-plenty": {
        "url": "https://www.metservice.com/publicData/rainRadar/image/bay-of-plenty/300K/",
        "gcps": [("662.56", "496.00", "176.4198", "-37.6050"), ("349.56", "372.27", "174.6273", "-37.0367"), ("286.18", "941.78", "174.2704", "-39.5911"), ("916.56", "868.60", "177.8677", "-39.2629")]
    },
    "new-plymouth": {
        "url": "https://www.metservice.com/publicData/rainRadar/image/new-plymouth/300K/",
        "gcps": [("605.65", "36.35", "174.2112", "-36.4294"), ("1086.72", "345.57", "176.9869", "-37.8569"), ("403.84", "948.31", "173.0398", "-40.5582"), ("749.34", "1134.41", "175.0433", "-41.3731")]
    },
    "mahia": {
        "url": "https://www.metservice.com/publicData/rainRadar/image/mahia/300K/",
        "gcps": [("138.125", "75.0565", "175.2023", "-36.7648"), ("715.125", "275.27", "178.5507", "-37.6906"), ("596.687", "621.647", "177.8658", "-39.2641"), ("43.8125", "1091.62", "174.6601", "-41.3413")]
    },
    "wellington": {
        "url": "https://www.metservice.com/publicData/rainRadar/image/wellington/300K/",
        "gcps": [("537.53", "221.53", "174.2696", "-39.5913"), ("1138.72", "151.19", "177.8650", "-39.2642"), ("332.56", "433.40", "173.0383", "-40.5580"), ("274.53", "1110.91", "172.6932", "-43.5703")]
    },
    "westland": {
        "url": "https://www.metservice.com/publicData/rainRadar/image/westland/300K/",
        "gcps": [("923.59", "123.17", "173.0381", "-40.5580"), ("1125.75", "376.42", "174.2760", "-41.7276"), ("651.31", "898.38", "171.3699", "-44.0673"), ("117.75", "1068.38", "168.1082", "-44.8101")]
    },
    "christchurch": {
        "url": "https://www.metservice.com/publicData/rainRadar/image/christchurch/300K/",
        "gcps": [("531.75", "166.75", "171.5913", "-41.8054"), ("962.625", "149.875", "174.2763", "-41.7263"), ("54.125", "638.82", "168.6226", "-43.9599"), ("332.5", "1076.56", "170.3561", "-45.8903")]
    },
    "otago": {
        "url": "https://www.metservice.com/publicData/rainRadar/image/otago/300K/",
        "gcps": [("633.47", "48.375", "170.6312", "-43.1548"), ("946.66", "94.696", "172.6469", "-43.3745"), ("576.56", "651.24", "170.2630", "-45.9190"), ("35.438", "720.56", "166.7810", "-46.2276")]
    },
    "invercargill": {
        "url": "https://www.metservice.com/publicData/rainRadar/image/invercargill/300K/",
        "gcps": [("645.625", "64.4375", "168.6225", "-43.9598"), ("1124.06", "53.125", "171.7448", "-43.9054"), ("315.688", "509.395", "166.4719", "-46.0111"), ("828.813", "606.619", "169.8182", "-46.4486")]
    }
}

WARM_COLORS = [(146, 154, 0), (181, 188, 0), (217, 228, 0), (251, 255, 102), (251, 255, 0), (253, 244, 0), (253, 240, 0), (254, 224, 0), (253, 204, 0), (255, 180, 0), (255, 160, 0), (229, 56, 0), (255, 72, 0), (111, 7, 158), (194, 55, 227), (57, 178, 0), (105, 253, 0), (212, 46, 147), (238, 55, 202), (255, 63, 255)]

s3_client = boto3.client('s3')

def ensure_dir(d):
    os.makedirs(d, exist_ok=True)

def process_image(name, config):
    print(f"[{name}] Processing...")
    try:
        r = requests.get(config['url'], stream=True, timeout=30)
        print(f"[{name}] HTTP {r.status_code}, Content-Length: {r.headers.get('content-length', 'unknown')}")
        r.raise_for_status()
        img_array = np.asarray(bytearray(r.content), dtype=np.uint8)
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        
        if img is None:
            # Try alternative decoding methods
            print(f"[{name}] Trying alternative decode methods...")
            img = cv2.imdecode(img_array, cv2.IMREAD_UNCHANGED)
            if img is None:
                print(f"[{name}] Failed to decode image with all methods")
                return None

        print(f"[{name}] Image decoded: {img.shape}")

        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        
        # Blue mask (rain)
        mask_blue = cv2.inRange(hsv, np.array([85, 30, 30]), np.array([135, 255, 255]))
        
        # Warm mask (heavy rain)
        mask_warm = np.zeros(img.shape[:2], dtype="uint8")
        for rgb in WARM_COLORS:
            pixel = np.uint8([[[rgb[2], rgb[1], rgb[0]]]])
            hsv_p = cv2.cvtColor(pixel, cv2.COLOR_BGR2HSV)[0][0]
            h, s, v = int(hsv_p[0]), int(hsv_p[1]), int(hsv_p[2])
            mask = cv2.inRange(hsv, np.array([max(0, h-10), max(40, s-50), max(40, v-50)]), np.array([min(180, h+10), min(255, s+50), min(255, v+50)]))
            mask_warm = cv2.bitwise_or(mask_warm, mask)

        # Snow mask
        mask_snow = cv2.inRange(hsv, np.array([0, 0, 230]), np.array([180, 20, 255]))
        mask_snow = cv2.morphologyEx(mask_snow, cv2.MORPH_OPEN, np.ones((3,3), np.uint8))
        
        # Combine masks
        final_mask = cv2.bitwise_or(cv2.bitwise_or(mask_blue, mask_warm), mask_snow)
        final_mask = cv2.morphologyEx(final_mask, cv2.MORPH_CLOSE, np.ones((3,3), np.uint8), iterations=2)
        final_mask = cv2.morphologyEx(final_mask, cv2.MORPH_OPEN, np.ones((2,2), np.uint8))
        
        # Clean borders
        h, w = img.shape[:2]
        final_mask[0:5, :] = 0
        final_mask[h-5:h, :] = 0
        final_mask[:, 0:5] = 0
        final_mask[:, w-5:w] = 0

        # Apply alpha
        img_rgba = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
        img_rgba[:, :, 3] = final_mask
        
        png_path = os.path.join(OUTPUT_FOLDER, f"{name}.png")
        cv2.imwrite(png_path, img_rgba)
        print(f"[{name}] Saved to {png_path}")
        return png_path
        
    except Exception as e:
        print(f"[{name}] Failed: {e}")
        import traceback
        traceback.print_exc()
        return None

def georeference(name, png_path, gcps):
    vrt_path = os.path.join(OUTPUT_FOLDER, f"{name}.vrt")
    cmd = ["gdal_translate", "-of", "VRT", "-a_srs", "EPSG:4326"]
    for gcp in gcps:
        cmd.extend(["-gcp", gcp[0], gcp[1], gcp[2], gcp[3]])
    cmd.extend([png_path, vrt_path])
    
    try:
        print(f"[{name}] Running: {' '.join(cmd)}")
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        print(f"[{name}] Georeferencing successful")
        return vrt_path
    except subprocess.CalledProcessError as e:
        print(f"[{name}] Georeferencing failed: {e}")
        print(f"[{name}] STDERR: {e.stderr}")
        return None

def process_region(name, config):
    png_path = process_image(name, config)
    if png_path:
        return georeference(name, png_path, config['gcps'])
    return None

def create_mosaic(vrt_files):
    print(f"Creating mosaic from {len(vrt_files)} regions...")
    output_tif = os.path.join(OUTPUT_FOLDER, "nz_mosaic.tif")
    
    cmd = ["gdalwarp", "-t_srs", "EPSG:3857", "-r", "bilinear", "-overwrite", "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE"]
    cmd.extend(vrt_files)
    cmd.append(output_tif)
    
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return output_tif

def generate_tiles(mosaic_tif):
    print("Generating tiles...")
    subprocess.run(["gdal2tiles.py", "-z", "6-10", "--processes=4", mosaic_tif, TILES_FOLDER], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def upload_tiles():
    print("Uploading tiles to S3...")
    for root, dirs, files in os.walk(TILES_FOLDER):
        for file in files:
            if file.endswith('.png'):
                local_path = os.path.join(root, file)
                rel_path = os.path.relpath(local_path, TILES_FOLDER)
                s3_key = f"{S3_PREFIX}/{rel_path}"
                
                s3_client.upload_file(local_path, S3_BUCKET, s3_key, ExtraArgs={'ContentType': 'image/png', 'CacheControl': 'max-age=300'})

def main():
    if not S3_BUCKET:
        print("TILES_BUCKET environment variable not set")
        return
        
    ensure_dir(OUTPUT_FOLDER)
    ensure_dir(TILES_FOLDER)
    
    print(f"Processing {len(REGIONS)} regions in parallel...")
    
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(process_region, name, config): name for name, config in REGIONS.items()}
        
        valid_vrts = []
        for future in as_completed(futures):
            name = futures[future]
            try:
                vrt_path = future.result()
                if vrt_path:
                    valid_vrts.append(vrt_path)
            except Exception as e:
                print(f"[{name}] Error: {e}")
    
    if not valid_vrts:
        print("No valid regions processed")
        return
    
    mosaic_tif = create_mosaic(valid_vrts)
    generate_tiles(mosaic_tif)
    upload_tiles()
    
    print(f"Completed at {datetime.now()}")

if __name__ == "__main__":
    main()