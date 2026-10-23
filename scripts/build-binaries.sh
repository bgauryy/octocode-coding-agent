#!/usr/bin/env bash
#
# Build octocode binaries for all platforms locally.
# CI (.github/workflows/ci.yml) does not build binaries; this script is the build recipe.
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-install] [--skip-build] [--offline-model-data] [--platform <platform>] [--out <dir>]
#
# Options:
#   --skip-install       Skip yarn install
#   --skip-build         Skip the package build
#   --offline-model-data Build with bundled model data instead of refreshing it
#   --platform <name>    Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>          Output directory (default: packages/coding-agent/binaries)
#
# Output:
#   packages/coding-agent/binaries/
#     octocode-darwin-arm64.tar.gz
#     octocode-darwin-x64.tar.gz
#     octocode-linux-x64.tar.gz
#     octocode-linux-arm64.tar.gz
#     octocode-windows-x64.zip
#     octocode-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
PLATFORM=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    yarn install --immutable --mode=skip-build
else
    echo "==> Skipping yarn install (--skip-install)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building all packages with bundled model data..."
        yarn run build:offline
    else
        echo "==> Building all packages..."
        yarn run build
    fi
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    bun_target="bun-$platform"
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi

    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. Bun places them at their path relative to the
    # common directory of all entrypoints, so the main entry must stay in dist/
    # for the worker specifiers in the runtime to resolve.
    #
    # Disable cwd bunfig.toml autoload so project preload scripts cannot crash the
    # standalone binary before octocode starts (see #7684). Disable cwd .env autoload so
    # project env files do not leak into octocode's environment (see #10473).
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/octocode.exe"
    else
        bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/octocode"
    fi
done

echo "==> Creating release archives..."

# Stage the files each binary reads next to itself (one owner: scripts/stage-binary.mjs).
for platform in "${PLATFORMS[@]}"; do
    node ../../scripts/stage-binary.mjs "$OUTPUT_DIR/$platform" --platform "$platform"
done

# Create archives
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows (zip)
        echo "Creating octocode-$platform.zip..."
        (cd "$platform" && zip -r ../octocode-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating octocode-$platform.tar.gz..."
        mv "$platform" octocode && tar -czf octocode-$platform.tar.gz octocode && mv octocode "$platform"
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../octocode-$platform.zip)
    else
        tar -xzf octocode-$platform.tar.gz && mv octocode "$platform"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/octocode.exe"
    else
        echo "  $OUTPUT_DIR/$platform/octocode"
    fi
done
