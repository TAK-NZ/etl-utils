#!/usr/bin/env python3
import os
from datetime import datetime

if __name__ == "__main__":
    # Import and run main processing once
    from process_radar import main
    
    try:
        print(f"Starting radar processing at {datetime.now()}")
        main()
        print(f"Radar processing completed at {datetime.now()}")
    except Exception as e:
        print(f"Error in radar processing: {e}")
        exit(1)