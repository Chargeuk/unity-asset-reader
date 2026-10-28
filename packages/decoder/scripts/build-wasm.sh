#!/bin/bash

# Build with the pinned native SDK on PATH, or the pinned Docker SDK.
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
OUTPUT_DIR="$PROJECT_ROOT/wasm"

# Keep the published decoder's toolchain pin on both routes (#57).
EMSDK_IMAGE="emscripten/emsdk:4.0.7@sha256:8acec700a48dbff5250afc1e3ee545b7c002b689043ee82c277de6481a237fd7"
# The official 4.0.7 SDK reports 4.0.7-git with this Emscripten revision.
EMSCRIPTEN_REVISION="8dc91db45bf96c174531006839472a3924d105aa"
NATIVE_VERSION_PATTERN="^em(cc|\+\+) \(Emscripten[^)]*\) 4\.0\.7( \($EMSCRIPTEN_REVISION\))?$"
NATIVE_GIT_PATTERN="^em(cc|\+\+) \(Emscripten[^)]*\) 4\.0\.7-git \($EMSCRIPTEN_REVISION\)$"

RUNNER=()
NATIVE_AVAILABLE=false
NATIVE_CONTEXT="em++ was not found on PATH"
if command -v em++ >/dev/null 2>&1; then
    if VERSION_OUTPUT="$(em++ --version 2>&1)"; then
        VERSION_LINE="${VERSION_OUTPUT%%$'\n'*}"
        if [[ "$VERSION_LINE" =~ $NATIVE_VERSION_PATTERN || "$VERSION_LINE" =~ $NATIVE_GIT_PATTERN ]]; then
            NATIVE_AVAILABLE=true
        else
            NATIVE_CONTEXT="incompatible native em++: $VERSION_LINE"
        fi
    else
        NATIVE_CONTEXT="native em++ --version failed: $VERSION_OUTPUT"
    fi
fi

if "$NATIVE_AVAILABLE"; then
    if ! command -v node >/dev/null 2>&1; then
        echo "Error building decoder WASM: native em++ 4.0.7 needs node on PATH for scripts/patch-glue.mjs" >&2
        exit 1
    fi
    echo "Building decoder WASM with native $VERSION_LINE"
else
    if ! command -v docker >/dev/null 2>&1; then
        echo "Error building decoder WASM: $NATIVE_CONTEXT; Docker is also unavailable." >&2
        echo "Provide native em++ 4.0.7 (4.0.7-git requires $EMSCRIPTEN_REVISION), or Docker for $EMSDK_IMAGE." >&2
        exit 1
    fi
    echo "$NATIVE_CONTEXT; building decoder WASM with $EMSDK_IMAGE"
    RUNNER=(docker run --rm -v "$PROJECT_ROOT:/project" -w /project "$EMSDK_IMAGE")
fi

mkdir -p "$OUTPUT_DIR"
cd "$PROJECT_ROOT"

# Relative paths work unchanged from the native cwd and the container's /project mount.
# Keep one source/argument list so neither route can silently use different codec flags.
SOURCE_DIR="texture2ddecoder/src/Texture2DDecoder"
COMPILER_ARGS=(
    "$SOURCE_DIR/bcn.cpp"
    "$SOURCE_DIR/pvrtc.cpp"
    "$SOURCE_DIR/etc.cpp"
    "$SOURCE_DIR/atc.cpp"
    "$SOURCE_DIR/astc.cpp"
    "$SOURCE_DIR/crunch.cpp"
    "$SOURCE_DIR/unitycrunch.cpp"
    wasm_bindings.cpp
    "-I$SOURCE_DIR"
    -D__LITTLE_ENDIAN__=1
    -O3
    -s WASM=1
    -s ALLOW_MEMORY_GROWTH=1
    -s MODULARIZE=1
    -s EXPORT_NAME=createModule
    -s EXPORT_ES6=1
    -s ENVIRONMENT=web,worker,node
    -s FILESYSTEM=0
    -s DISABLE_EXCEPTION_CATCHING=0
    -s ALLOW_TABLE_GROWTH=1
    -s 'EXPORTED_RUNTIME_METHODS=[ccall,cwrap]'
    -s 'INCOMING_MODULE_JS_API=[locateFile]'
    --bind
    -std=c++17
    -o wasm/texture2ddecoder.js
)

if "${RUNNER[@]}" em++ "${COMPILER_ARGS[@]}"; then
    # Keep patching in the same environment as compilation (including Docker file ownership).
    "${RUNNER[@]}" node scripts/patch-glue.mjs
else
    STATUS=$?
    echo "Error building decoder WASM: em++ compilation failed (exit $STATUS)." >&2
    exit "$STATUS"
fi

echo "Generated and patched $OUTPUT_DIR/texture2ddecoder.js and texture2ddecoder.wasm"
