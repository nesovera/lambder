#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# Update the version, build the project, and publish
rm -rf ./dist/*
npm version patch
npm run build
npm publish

echo "All operations completed successfully"
