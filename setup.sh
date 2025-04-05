#!/bin/bash
set -e

echo "Starting BERTopic environment setup..."

# Check if python3-venv is installed, install if missing
if ! dpkg -l | grep -q python3-venv; then
  echo "Installing python3-venv..."
  sudo apt update
  sudo apt install -y python3-venv
fi

# Get the path to the python directory
SCRIPT_DIR=$(dirname "$(realpath "$0")")
PYTHON_DIR="$SCRIPT_DIR/src/python"

# Remove any existing venv to start fresh
if [ -d "$PYTHON_DIR/venv" ]; then
  echo "Removing existing virtual environment..."
  rm -rf "$PYTHON_DIR/venv"
fi

# Create directories
echo "Creating necessary directories..."
mkdir -p "$PYTHON_DIR/models/bertopic_model"

# Create a fresh virtual environment
echo "Creating Python virtual environment..."
python3 -m venv "$PYTHON_DIR/venv" --clear

# Ensure pip is available and up to date
echo "Setting up pip..."
"$PYTHON_DIR/venv/bin/python" -m ensurepip --upgrade
"$PYTHON_DIR/venv/bin/pip" install --upgrade pip setuptools wheel

# Run the TypeScript setup
echo "Running TypeScript setup..."
pnpm run setup-python

echo "Setup completed!"