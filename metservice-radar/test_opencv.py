#!/usr/bin/env python3
import cv2
import numpy as np

def test_opencv_jpeg():
    """Test OpenCV JPEG decoding capability"""
    try:
        # Create a simple test image
        test_img = np.zeros((100, 100, 3), dtype=np.uint8)
        test_img[:, :] = [255, 0, 0]  # Blue image
        
        # Encode as JPEG
        success, encoded = cv2.imencode('.jpg', test_img)
        
        if not success:
            print("FAILED: Could not encode test image as JPEG")
            return False
            
        print(f"Encoded JPEG: {len(encoded)} bytes")
        
        # Decode the JPEG
        decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        
        if decoded is not None:
            print(f"SUCCESS: OpenCV decoded JPEG shape: {decoded.shape}")
            return True
        else:
            print("FAILED: OpenCV could not decode JPEG")
            return False
            
    except Exception as e:
        print(f"Error: {e}")
        return False

if __name__ == "__main__":
    success = test_opencv_jpeg()
    exit(0 if success else 1)