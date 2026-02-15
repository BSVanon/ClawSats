#!/bin/bash
# ClawSats Wallet Auto-Deployment Script
# Version: 1.0
# Usage: ./auto-deploy.sh [CLAW_ID] [INVITATION_TOKEN] [CONFIG_URL]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
DEFAULT_CLAW_ID="claw-$(date +%s)"
DEFAULT_INVITATION_TOKEN=""
DEFAULT_CONFIG_URL=""
DEFAULT_INSTALL_DIR="/opt/clawsats"
DEFAULT_DATA_DIR="/var/lib/clawsats"
DEFAULT_USER="clawsats"
DEFAULT_GROUP="clawsats"
DEFAULT_PORT="3321"
DEFAULT_CHAIN="main"

# Parse arguments
CLAW_ID="${1:-$DEFAULT_CLAW_ID}"
INVITATION_TOKEN="${2:-$DEFAULT_INVITATION_TOKEN}"
CONFIG_URL="${3:-$DEFAULT_CONFIG_URL}"

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check if running as root
    if [[ $EUID -ne 0 ]]; then
        log_warning "Running without root privileges. Some operations may fail."
    fi
    
    # Check required commands
    local missing_commands=()
    for cmd in curl git node npm systemctl; do
        if ! command -v $cmd &> /dev/null; then
            missing_commands+=("$cmd")
        fi
    done
    
    if [[ ${#missing_commands[@]} -gt 0 ]]; then
        log_error "Missing required commands: ${missing_commands[*]}"
        log_info "Please install missing packages before continuing."
        return 1
    fi
    
    # Check Node.js version
    local node_version=$(node --version | cut -d'v' -f2)
    local major_version=$(echo $node_version | cut -d'.' -f1)
    if [[ $major_version -lt 18 ]]; then
        log_error "Node.js version $node_version is too old. Minimum required: 18.x"
        return 1
    fi
    
    log_success "Prerequisites check passed"
    return 0
}

# Create system user
create_system_user() {
    log_info "Creating system user and group..."
    
    if ! id "$DEFAULT_USER" &>/dev/null; then
        useradd -r -s /bin/false -d "$DEFAULT_DATA_DIR" -m "$DEFAULT_USER"
        log_success "Created user: $DEFAULT_USER"
    else
        log_info "User $DEFAULT_USER already exists"
    fi
    
    if ! getent group "$DEFAULT_GROUP" &>/dev/null; then
        groupadd "$DEFAULT_GROUP"
        log_success "Created group: $DEFAULT_GROUP"
    else
        log_info "Group $DEFAULT_GROUP already exists"
    fi
}

# Download and install wallet
install_wallet() {
    log_info "Installing ClawSats wallet from GitHub..."

    local repo_url="https://github.com/BSVanon/ClawSats.git"

    if [[ -d "$DEFAULT_INSTALL_DIR/.git" ]]; then
        log_info "Existing repository found. Pulling latest main..."
        if ! git -C "$DEFAULT_INSTALL_DIR" pull --ff-only origin main; then
            log_error "Failed to update existing repository at $DEFAULT_INSTALL_DIR"
            return 1
        fi
    else
        if [[ -d "$DEFAULT_INSTALL_DIR" ]]; then
            log_info "Using existing installation directory: $DEFAULT_INSTALL_DIR"
        else
            mkdir -p "$DEFAULT_INSTALL_DIR"
            log_success "Created installation directory: $DEFAULT_INSTALL_DIR"
        fi

        if ! git clone --depth 1 "$repo_url" "$DEFAULT_INSTALL_DIR"; then
            log_error "Failed to clone repository: $repo_url"
            return 1
        fi
    fi

    if [[ ! -d "$DEFAULT_INSTALL_DIR/clawsats-wallet" ]]; then
        log_error "clawsats-wallet directory not found after clone/update"
        return 1
    fi

    chown -R "$DEFAULT_USER:$DEFAULT_GROUP" "$DEFAULT_INSTALL_DIR"
    chmod -R 750 "$DEFAULT_INSTALL_DIR"

    log_success "Wallet source installed at: $DEFAULT_INSTALL_DIR/clawsats-wallet"
    return 0
}

# Install dependencies
install_dependencies() {
    log_info "Installing Node.js dependencies..."
    
    cd "$DEFAULT_INSTALL_DIR/clawsats-wallet"

    if [[ -f package-lock.json ]]; then
        if ! npm ci --omit=dev; then
            log_warning "Failed npm ci --omit=dev, trying npm install --omit=dev..."
            if ! npm install --omit=dev; then
                log_error "Failed to install production dependencies"
                return 1
            fi
        fi
    else
        if ! npm install --omit=dev; then
            log_error "Failed to install dependencies"
            return 1
        fi
    fi

    # If dist was not committed, build it from source.
    if [[ ! -f "$DEFAULT_INSTALL_DIR/clawsats-wallet/dist/cli/index.js" ]]; then
        log_warning "dist/cli/index.js missing. Installing dev deps to build..."
        if ! npm install; then
            log_error "Failed to install dev dependencies required for build"
            return 1
        fi
        if ! npm run build; then
            log_error "Build failed"
            return 1
        fi
        npm prune --omit=dev || true
    fi

    log_success "Dependencies installed and CLI verified"
    return 0
}

# Configure wallet
configure_wallet() {
    log_info "Configuring wallet..."
    
    # Create config directory
    local config_dir="$DEFAULT_DATA_DIR/config"
    mkdir -p "$config_dir"
    
    # Download config if URL provided
    if [[ -n "$CONFIG_URL" && "$CONFIG_URL" != "none" ]]; then
        log_info "Downloading configuration from: $CONFIG_URL"
        if ! curl -sSL -o "$config_dir/wallet-config.json" "$CONFIG_URL"; then
            log_warning "Failed to download configuration, using defaults"
        fi
    fi
    
    # Generate wallet config using the CLI (creates rootKeyHex, identity key, SQLite DB)
    if [[ ! -f "$config_dir/wallet-config.json" ]]; then
        log_info "Generating wallet via CLI (creates rootKeyHex + identity key)..."
        cd "$DEFAULT_INSTALL_DIR"
        /usr/bin/node clawsats-wallet/dist/cli/index.js create \
            --name "$CLAW_ID" \
            --chain "$DEFAULT_CHAIN" \
            --storage sqlite
        # Move generated config to the data directory
        if [[ -f "$DEFAULT_INSTALL_DIR/config/wallet-config.json" ]]; then
            mv "$DEFAULT_INSTALL_DIR/config/wallet-config.json" "$config_dir/wallet-config.json"
            log_success "Wallet config generated with proper rootKeyHex"
        else
            log_error "CLI did not generate wallet-config.json"
            return 1
        fi
    fi
    
    # Set permissions
    chown -R "$DEFAULT_USER:$DEFAULT_GROUP" "$DEFAULT_DATA_DIR"
    chmod -R 750 "$DEFAULT_DATA_DIR"
    
    log_success "Wallet configured"
    return 0
}

# Create systemd service
create_systemd_service() {
    log_info "Creating systemd service..."
    
    local service_file="/etc/systemd/system/clawsats-wallet.service"
    
    cat > "$service_file" << EOF
[Unit]
Description=ClawSats Wallet Service
Documentation=https://github.com/BSVanon/ClawSats
After=network.target

[Service]
Type=simple
User=$DEFAULT_USER
Group=$DEFAULT_GROUP
WorkingDirectory=$DEFAULT_INSTALL_DIR
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $DEFAULT_INSTALL_DIR/clawsats-wallet/dist/cli/index.js serve --config $DEFAULT_DATA_DIR/config/wallet-config.json
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=clawsats-wallet

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DEFAULT_DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
    
    # Reload systemd
    systemctl daemon-reload
    
    # Enable service
    systemctl enable clawsats-wallet.service
    
    log_success "Systemd service created and enabled"
    return 0
}

# Test wallet functionality
test_wallet() {
    log_info "Testing wallet functionality..."
    
    # Start service
    log_info "Starting wallet service..."
    if ! systemctl start clawsats-wallet.service; then
        log_error "Failed to start wallet service"
        systemctl status clawsats-wallet.service
        return 1
    fi
    
    # Wait for service to start
    sleep 5
    
    # Test health endpoint
    local health_url="http://localhost:$DEFAULT_PORT/health"
    log_info "Testing health endpoint: $health_url"
    
    if ! curl -s -f "$health_url" > /dev/null; then
        log_error "Health check failed"
        systemctl status clawsats-wallet.service
        return 1
    fi
    
    log_success "Wallet service is healthy"
    return 0
}

# Share capability with other Claws
share_capability() {
    log_info "Sharing wallet capability with other Claws..."
    
    # Generate invitation
    local invitation_file="/tmp/clawsats-invitation-$(date +%s).json"
    
    /usr/bin/node $DEFAULT_INSTALL_DIR/clawsats-wallet/dist/cli/index.js share \
        --recipient "http://localhost:$DEFAULT_PORT" \
        --output "$invitation_file"
    
    if [[ -f "$invitation_file" ]]; then
        log_info "Generated invitation: $invitation_file"
        log_info "Share this invitation with other Claws to enable self-spreading"
        
        # Example: Share via BRC-33 MessageBox
        log_info "To share via BRC-33 MessageBox:"
        echo "  /usr/bin/node $DEFAULT_INSTALL_DIR/clawsats-wallet/dist/cli/index.js share -r claw://peer-id --output $invitation_file"
        
        # Example: Share via overlay network
        log_info "To share via overlay network:"
        echo "  /usr/bin/node $DEFAULT_INSTALL_DIR/clawsats-wallet/dist/cli/index.js announce --endpoint http://YOUR_VPS_IP:$DEFAULT_PORT"
    fi
    
    return 0
}

# Main deployment function
main() {
    log_info "Starting ClawSats Wallet Auto-Deployment"
    log_info "Claw ID: $CLAW_ID"
    log_info "Installation directory: $DEFAULT_INSTALL_DIR"
    log_info "Data directory: $DEFAULT_DATA_DIR"
    
    # Run deployment steps
    check_prerequisites || exit 1
    create_system_user || exit 1
    install_wallet || exit 1
    install_dependencies || exit 1
    configure_wallet || exit 1
    create_systemd_service || exit 1
    test_wallet || exit 1
    share_capability || log_warning "Failed to share capability (non-critical)"
    
    log_success "🎉 ClawSats Wallet deployment completed successfully!"
    log_info ""
    log_info "Next steps:"
    log_info "1. Wallet is running on port $DEFAULT_PORT"
    log_info "2. Check health: curl http://localhost:$DEFAULT_PORT/health"
    log_info "3. View configuration: cat $DEFAULT_DATA_DIR/config/wallet-config.json"
    log_info "4. Stop service: systemctl stop clawsats-wallet"
    log_info "5. View logs: journalctl -u clawsats-wallet -f"
    log_info ""
    log_info "To invite other Claws:"
    log_info "  /usr/bin/node $DEFAULT_INSTALL_DIR/clawsats-wallet/dist/cli/index.js share --help"
    log_info ""
    log_info "For support: https://github.com/BSVanon/ClawSats/issues"
}

# Run main function
main "$@"
