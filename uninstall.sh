#!/usr/bin/env bash
#
# AFK CLI - Uninstallation Script
# Removes afk CLI tool from system
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info() {
    echo -e "${BLUE}ℹ ${NC}$1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1" >&2
}

# Parse arguments
FORCE=false
REMOVE_CONFIG=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --force)
            FORCE=true
            shift
            ;;
        --remove-config)
            REMOVE_CONFIG=true
            shift
            ;;
        -h|--help)
            cat <<EOF
AFK CLI Uninstallation Script

Usage: $0 [OPTIONS]

Options:
  --force           Skip confirmation prompt
  --remove-config   Also remove config files (~/.config/afk)
  -h, --help        Show this help message

Examples:
  $0                        # Interactive uninstall
  $0 --force                # Uninstall without confirmation
  $0 --force --remove-config # Remove everything including config
EOF
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║   AFK CLI Uninstallation              ║"
echo "╚═══════════════════════════════════════╝"
echo ""

# Find afk installation
if ! command -v afk &> /dev/null; then
    print_error "afk is not installed"
    exit 1
fi

AFK_PATH=$(command -v afk)
print_info "Found installation: $AFK_PATH"

# Confirm uninstallation
if [[ "$FORCE" == false ]]; then
    echo ""
    print_warning "This will remove afk from your system"
    read -p "Continue? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Uninstallation cancelled"
        exit 0
    fi
fi

# Remove executable
print_info "Removing executable..."
if [[ -w "$AFK_PATH" ]]; then
    rm -f "$AFK_PATH"
    print_success "Removed $AFK_PATH"
else
    if sudo rm -f "$AFK_PATH"; then
        print_success "Removed $AFK_PATH (required sudo)"
    else
        print_error "Failed to remove $AFK_PATH"
        exit 1
    fi
fi

# Remove config if requested
if [[ "$REMOVE_CONFIG" == true ]]; then
    CONFIG_DIR="$HOME/.config/afk"
    if [[ -d "$CONFIG_DIR" ]]; then
        print_info "Removing configuration..."
        rm -rf "$CONFIG_DIR"
        print_success "Removed $CONFIG_DIR"
    fi
fi

# Verify removal
if command -v afk &> /dev/null; then
    print_warning "afk is still in PATH (possibly cached)"
    echo "Try: hash -r (bash) or rehash (zsh)"
else
    print_success "afk successfully uninstalled"
fi

echo ""
print_success "Uninstallation complete!"
echo ""

exit 0
