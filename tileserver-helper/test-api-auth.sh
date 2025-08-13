#!/bin/bash

# Test API key authentication for tileserver
TILES_URL="https://tiles.test.tak.nz"

echo "Testing API key authentication..."

# Test without API key (should fail)
echo "1. Testing without API key (should return 401):"
curl -s -o /dev/null -w "%{http_code}" "$TILES_URL/styles/topolite"
echo

# Test with invalid API key (should fail)
echo "2. Testing with invalid API key (should return 403):"
curl -s -o /dev/null -w "%{http_code}" "$TILES_URL/styles/topolite?api=invalid-key"
echo

# Test with valid demo API key (should succeed)
echo "3. Testing with valid demo API key (should return 200):"
curl -s -o /dev/null -w "%{http_code}" "$TILES_URL/styles/topolite?api=your-demo-api-key-here"
echo

# Test health endpoint (should work without API key)
echo "4. Testing health endpoint (should return 200):"
curl -s -o /dev/null -w "%{http_code}" "$TILES_URL/health"
echo

echo "Test complete!"