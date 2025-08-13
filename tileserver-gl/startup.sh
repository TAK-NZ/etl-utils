#!/bin/sh

# Download config from S3 if CONFIG_BUCKET is set
if [ -n "$CONFIG_BUCKET" ] && [ -n "$CONFIG_KEY" ]; then
    echo "Downloading config from S3: s3://$CONFIG_BUCKET/$CONFIG_KEY"
    aws s3 cp "s3://$CONFIG_BUCKET/$CONFIG_KEY" /tmp/s3-config.json
    
    if [ $? -eq 0 ]; then
        echo "Successfully downloaded config from S3"
        echo "S3 config contents:"
        cat /tmp/s3-config.json
        # Extract authkey and apikey from S3 config and update style files
        AUTHKEY=$(cat /tmp/s3-config.json | sed -n 's/.*"authkey":\s*"\([^"]*\)".*/\1/p')
        APIKEY=$(cat /tmp/s3-config.json | sed -n 's/.*"apikey":\s*"\([^"]*\)".*/\1/p')
        echo "Extracted AUTHKEY: $AUTHKEY"
        echo "Extracted APIKEY: $APIKEY"
        
        if [ -n "$AUTHKEY" ] && [ -n "$APIKEY" ]; then
            echo "Updating style files with API keys"
            # Update all style files with the API keys
            for style_file in /data/*-style.json; do
                if [ -f "$style_file" ]; then
                    sed -i "s/PLACEHOLDER_API_KEY/$APIKEY/g" "$style_file"
                    sed -i "s/PLACEHOLDER_AUTH_KEY/$AUTHKEY/g" "$style_file"
                    echo "Updated $style_file with API keys"
                fi
            done
        else
            echo "Warning: authkey or apikey not found in S3 config"
        fi
        
        rm /tmp/s3-config.json
    else
        echo "Failed to download config from S3, using default configuration"
    fi
else
    echo "CONFIG_BUCKET or CONFIG_KEY not set, using default configuration"
fi

# Start virtual display for headless operation
Xvfb :99 -screen 0 1024x768x24 &
export DISPLAY=:99

# Wait for display to start
sleep 2

# Start tileserver-gl with memory limit
echo "Starting TileServer GL..."
exec node --max-old-space-size=3072 /usr/src/app/src/main.js --config /data/config.json --port 8080