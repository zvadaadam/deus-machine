#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"
BUILD_DIR="$NATIVE_DIR/.build/siminspector"
RELEASE_DIR="$NATIVE_DIR/.build/release"

mkdir -p "$BUILD_DIR/arm64" "$BUILD_DIR/x86_64" "$RELEASE_DIR"

for ARCH in arm64 x86_64; do
  clang -dynamiclib -fobjc-arc \
    -isysroot "$SDK_PATH" \
    -arch "$ARCH" \
    -mios-simulator-version-min=15.0 \
    -framework Foundation \
    -framework UIKit \
    "$SCRIPT_DIR/Inspector.m" \
    -o "$BUILD_DIR/$ARCH/siminspector.dylib"
done

lipo -create \
  "$BUILD_DIR/arm64/siminspector.dylib" \
  "$BUILD_DIR/x86_64/siminspector.dylib" \
  -output "$RELEASE_DIR/siminspector.dylib"

echo "$RELEASE_DIR/siminspector.dylib"
