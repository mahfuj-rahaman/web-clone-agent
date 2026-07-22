# Clone
curl -X POST http://localhost:3000/api/clone \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","includeImages":true}'

# List
curl http://localhost:3000/api/clones

# Read file
curl "http://localhost:3000/api/clones/example.com_2026.../file?path=index.html"

# Download ZIP
curl -o clone.zip http://localhost:3000/api/clones/example.com_2026.../zip

# Delete
curl -X DELETE http://localhost:3000/api/clones/example.com_2026...
