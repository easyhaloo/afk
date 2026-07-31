#!/usr/bin/env bash
#
# AFK CLI - One-click Installation Script
# Installs afk CLI tool to /usr/local/bin (or /usr/bin with --system flag)
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DEFAULT_INSTALL_DIR="/usr/local/bin"
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
FORCE=false
SKIP_DEPS=false

# Print functions
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

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --system)
            INSTALL_DIR="/usr/bin"
            shift
            ;;
        --prefix)
            INSTALL_DIR="$2"
            shift 2
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        -h|--help)
            cat <<EOF
AFK CLI Installation Script

Usage: $0 [OPTIONS]

Options:
  --system        Install to /usr/bin instead of /usr/local/bin
  --prefix DIR    Install to custom directory
  --force         Overwrite existing installation
  --skip-deps     Skip dependency checks
  -h, --help      Show this help message

Examples:
  $0                          # Install to /usr/local/bin (default)
  $0 --system                 # Install to /usr/bin (requires sudo)
  $0 --prefix ~/.local/bin    # Install to user directory
  $0 --force                  # Force reinstall

Requirements:
  - Node.js v18+
  - npm v9+
  - Git
EOF
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            echo "Run '$0 --help' for usage information"
            exit 1
            ;;
    esac
done

# Check if running as root when installing to system directories
if [[ "$INSTALL_DIR" == "/usr/bin" ]] && [[ $EUID -ne 0 ]]; then
    print_error "Installing to /usr/bin requires sudo privileges"
    echo "Please run: sudo $0 --system"
    exit 1
fi

# Welcome message
echo ""
echo "╔═══════════════════════════════════════╗"
echo "║   AFK CLI Installation Script         ║"
echo "╚═══════════════════════════════════════╝"
echo ""

# Check dependencies
if [[ "$SKIP_DEPS" == false ]]; then
    print_info "Checking dependencies..."

    # Check Node.js
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed"
        echo "Please install Node.js v18+ from https://nodejs.org/"
        exit 1
    fi

    NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ $NODE_VERSION -lt 18 ]]; then
        print_error "Node.js v18+ required (found v$NODE_VERSION)"
        exit 1
    fi
    print_success "Node.js v$(node --version)"

    # Check npm
    if ! command -v npm &> /dev/null; then
        print_error "npm is not installed"
        exit 1
    fi
    print_success "npm v$(npm --version)"

    # Check git
    if ! command -v git &> /dev/null; then
        print_warning "Git is not installed (optional but recommended)"
    else
        print_success "git v$(git --version | awk '{print $3}')"
    fi
fi

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
print_info "Source directory: $SCRIPT_DIR"

# Check if source files exist
if [[ ! -f "$SCRIPT_DIR/package.json" ]]; then
    print_error "package.json not found in $SCRIPT_DIR"
    echo "Please run this script from the afk-cli repository root"
    exit 1
fi

if [[ ! -d "$SCRIPT_DIR/src" ]]; then
    print_error "src/ directory not found in $SCRIPT_DIR"
    exit 1
fi

# Check if install directory exists
if [[ ! -d "$INSTALL_DIR" ]]; then
    print_error "Install directory does not exist: $INSTALL_DIR"
    echo "Please create it first: sudo mkdir -p $INSTALL_DIR"
    exit 1
fi

# Check if afk is already installed
if command -v afk &> /dev/null && [[ "$FORCE" == false ]]; then
    EXISTING_PATH=$(command -v afk)
    print_warning "afk is already installed at: $EXISTING_PATH"
    read -p "Overwrite? (Y/n) " -n 1 -r
    echo
    if [[ "$REPLY" =~ ^[Nn]$ ]]; then
        print_info "Installation cancelled"
        exit 0
    fi
fi

# Install npm dependencies (full, including devDependencies for build)
print_info "Installing npm dependencies..."
cd "$SCRIPT_DIR"
npm install --silent
print_success "Dependencies installed"

# Build TypeScript
print_info "Building TypeScript..."
npm run build > /dev/null
if [[ ! -f "$SCRIPT_DIR/dist/index.js" ]]; then
    print_error "Build failed: dist/index.js not found"
    exit 1
fi
print_success "Build completed"

# Create executable wrapper script
print_info "Creating executable wrapper..."
WRAPPER_PATH="$INSTALL_DIR/afk"

cat > "$WRAPPER_PATH" <<EOF
#!/usr/bin/env node
//
// AFK CLI - Unified workflow automation tool
// Installed from: $SCRIPT_DIR
// Installation date: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
//

const { spawn } = require('child_process');
const path = require('path');

// Run the actual CLI
const cliPath = path.join('$SCRIPT_DIR', 'dist', 'index.js');
const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
EOF

chmod +x "$WRAPPER_PATH"
print_success "Executable created at $WRAPPER_PATH"

# Verify installation
print_info "Verifying installation..."
if ! command -v afk &> /dev/null; then
    print_error "Installation failed: afk command not found in PATH"
    echo "Try adding $INSTALL_DIR to your PATH:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    exit 1
fi

AFK_VERSION=$(afk --version 2>&1 || echo "unknown")
print_success "afk v$AFK_VERSION installed successfully"

# Test basic functionality
print_info "Testing basic functionality..."
if afk --help &> /dev/null; then
    print_success "Help command works"
else
    print_warning "Help command failed (non-critical)"
fi

# Show post-install information
echo ""
echo "╔═══════════════════════════════════════╗"
echo "║       Installation Complete! 🚀       ║"
echo "╚═══════════════════════════════════════╝"
echo ""
print_success "AFK CLI v$AFK_VERSION installed to $WRAPPER_PATH"
echo ""
echo "Next steps:"
echo "  1. Verify:  afk --version  |  afk --help"
echo "  2. Configure tokens:"
echo "       export GITLAB_TOKEN=glpat-xxxxxxxxxxxxx   # https://gitlab.com/-/profile/personal_access_tokens"
echo "       export GITHUB_TOKEN=ghp_xxxxxxxxxxxxx      # https://github.com/settings/tokens"
echo "  3. Run:     afk workflow launch --iid <issue-number>"
echo "              afk --help  # for all commands"
echo ""
exit 0
