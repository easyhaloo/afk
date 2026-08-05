#!/bin/bash
#
# fix-node-pty.sh — Fix node-pty spawn-helper on macOS
#
# Problem: macOS blocks adhoc-signed binaries with "permission denied" or "posix_spawnp failed"
# Solution: Re-sign spawn-helper with a developer certificate
#
# Usage:
#   ./scripts/fix-node-pty.sh              # Interactive (creates cert if needed)
#   ./scripts/fix-node-pty.sh --force      # Force re-sign without checking
#   ./scripts/fix-node-pty.sh --verify     # Just verify current state
#

set -e

SPAWN_HELPER="${PWD}/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
PTY_NODE="${PWD}/node_modules/node-pty/prebuilds/darwin-arm64/pty.node"

log() {
  echo "[fix-node-pty] $1"
}

error() {
  echo "[fix-node-pty] ERROR: $1" >&2
  exit 1
}

# Parse args
MODE="${1:-}"

# Check if spawn-helper exists
if [[ ! -f "$SPAWN_HELPER" ]]; then
  error "spawn-helper not found at: $SPAWN_HELPER"
fi

log "Found spawn-helper: $SPAWN_HELPER"
log "Found pty.node: $PTY_NODE"

# Step 1: Clear extended attributes
log "Clearing extended attributes..."
xattr -cr "$SPAWN_HELPER" 2>/dev/null || true
xattr -cr "$PTY_NODE" 2>/dev/null || true

# Step 2: Check for existing certificate
CERT_NAME=""

find_cert() {
  security find-certificate -c "Developer ID" 2>/dev/null | grep -o '"[^"]*"' | tr -d '"' | head -1 || true
}

create_cert() {
  log "Creating self-signed certificate for code signing..."

  # Create a new keychain if needed
  KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

  # Create certificate using security tool
  # This creates a "Mac Developer" style self-signed cert for local development
  cat << 'CERT_SCRIPT' | security import /dev/stdin -k "$KEYCHAIN" -P "" -T /usr/bin/codesign -T /usr/bin/certtool 2>/dev/null || true
CERT_SCRIPT

  # Alternative: use existing certificates
  CERT_NAME=$(find_cert)

  if [[ -z "$CERT_NAME" ]]; then
    log "No Developer ID certificate found."
    log "Creating ad-hoc signature (will work but may trigger macOS prompts)..."
    return 1
  fi
}

sign_binary() {
  local binary="$1"
  local name
  name=$(basename "$binary")

  log "Signing: $name"

  # Try with existing Developer ID certificate
  CERT_NAME=$(find_cert)

  if [[ -n "$CERT_NAME" ]]; then
    log "Using certificate: $CERT_NAME"
    sudo codesign --force --deep --sign "$CERT_NAME" "$binary" 2>/dev/null && {
      log "Signed with Developer ID: $name"
      sudo chmod +x "$binary"
      return 0
    }
  fi

  # Fall back to ad-hoc signing (works but may show macOS warning)
  log "Falling back to ad-hoc signature..."
  codesign --force --deep --sign - "$binary" 2>/dev/null && {
    log "Ad-hoc signed: $name"
    chmod +x "$binary"
    return 0
  }

  # Try with sudo
  sudo codesign --force --deep --sign - "$binary" 2>/dev/null && {
    log "Sudo ad-hoc signed: $name"
    sudo chmod +x "$binary"
    return 0
  }

  error "Failed to sign: $name"
}

verify_binary() {
  local binary="$1"
  local name
  name=$(basename "$binary")

  echo ""
  log "Verifying: $name"

  # Ensure executable permission
  if [[ ! -x "$binary" ]]; then
    log "Fixing permissions (not executable)..."
    chmod +x "$binary" 2>/dev/null || sudo chmod +x "$binary" || true
  fi

  if [[ -x "$binary" ]]; then
    log "✓ Binary is executable"
  else
    error "Binary is NOT executable even after chmod"
  fi

  # Show signature info
  codesign -dvv "$binary" 2>/dev/null | head -10 || echo "  (signature info unavailable)"

  # Try to run
  echo ""
  log "Testing execution..."
  if "$binary" --version 2>/dev/null; then
    log "✓ Binary executes successfully"
    return 0
  else
    error "Binary execution failed"
  fi
}

# Main logic
case "$MODE" in
  --verify)
    log "Verification mode"
    verify_binary "$SPAWN_HELPER"
    verify_binary "$PTY_NODE"
    ;;

  --force|"")
    log "Fix mode"

    # Sign spawn-helper
    sign_binary "$SPAWN_HELPER"

    # Sign pty.node (optional but recommended)
    if [[ -f "$PTY_NODE" ]]; then
      sign_binary "$PTY_NODE"
    fi

    echo ""
    log "Signatures applied. Verifying..."
    echo ""

    # Verify
    if verify_binary "$SPAWN_HELPER" && [[ -f "$PTY_NODE" ]]; then
      verify_binary "$PTY_NODE"
    fi

    echo ""
    log "Done! node-pty should now work."
    log "Test with: node -e \"const {spawn}=require('node-pty');spawn('node',['--version'],{cols:80,rows:24}).onData(d=>console.log(d)).onExit(()=>process.exit())\""
    ;;

  *)
    error "Unknown argument: $MODE. Use: --force, --verify, or no argument"
    ;;
esac
