#!/bin/bash

echo "🚀 Complete MCP Setup for Cursor"
echo "=================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}✅${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠️${NC} $1"
}

print_error() {
    echo -e "${RED}❌${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ️${NC} $1"
}

# Check prerequisites
echo ""
print_info "Checking prerequisites..."

# Check if Cursor is installed
if ! command -v cursor &> /dev/null; then
    print_warning "Cursor is not installed or not in PATH"
    echo "Please install Cursor first: https://cursor.sh/"
    echo "You can continue with the setup and install Cursor later."
    read -p "Continue anyway? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    print_status "Cursor found"
fi

# Check if uvx is installed, install if needed
if ! command -v uvx &> /dev/null; then
    print_info "Installing uv and uvx..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    
    # Source the shell configuration
    if [ -f ~/.bashrc ]; then
        source ~/.bashrc 2>/dev/null || true
    fi
    if [ -f ~/.zshrc ]; then
        source ~/.zshrc 2>/dev/null || true
    fi
    
    # Add to PATH for current session
    export PATH="$HOME/.local/bin:$PATH"
    
    if ! command -v uvx &> /dev/null; then
        print_error "Failed to install uvx. Please install manually:"
        echo "   curl -LsSf https://astral.sh/uv/install.sh | sh"
        echo "   Then restart your terminal and run this script again."
        exit 1
    fi
else
    print_status "uvx found at: $(which uvx)"
fi

# Check if npx is available
if ! command -v npx &> /dev/null; then
    print_error "npx not found. Please install Node.js first."
    echo "Visit: https://nodejs.org/"
    exit 1
else
    print_status "npx found"
fi

# Create necessary directories
print_info "Creating necessary directories..."
mkdir -p ~/.local/share/uv
mkdir -p ~/.local/bin
mkdir -p ~/.cursor

# Set permissions
chmod 755 ~/.local ~/.local/share ~/.local/bin ~/.cursor 2>/dev/null || true
print_status "Directories created and permissions set"

# Check AWS configuration
print_info "Checking AWS configuration..."
if aws configure list-profiles | grep -q "wishy-profile"; then
    print_status "AWS profile 'wishy-profile' found"
    
    # Test AWS credentials
    if aws sts get-caller-identity --profile wishy-profile > /dev/null 2>&1; then
        print_status "AWS credentials are working"
    else
        print_warning "AWS credentials may need configuration"
        echo "Run: aws configure --profile wishy-profile"
    fi
else
    print_warning "AWS profile 'wishy-profile' not found"
    echo "You can set it up later with: aws configure --profile wishy-profile"
fi

# Install AWS MCP servers (these will be cached by uvx)
print_info "Preparing AWS MCP servers..."
echo "This may take a few minutes on first run..."

# Test each server (this will install them if needed)
servers=(
    "awslabs.core-mcp-server@latest"
    "awslabs.bedrock-kb-retrieval-mcp-server@latest"
    "awslabs.cdk-mcp-server@latest"
    "awslabs.cost-analysis-mcp-server@latest"
    "awslabs.nova-canvas-mcp-server@latest"
)

for server in "${servers[@]}"; do
    print_info "Preparing $server..."
    uvx "$server" --help > /dev/null 2>&1 || print_status "$server ready"
done

# Copy MCP configuration to Cursor
print_info "Copying MCP configuration to Cursor..."
if [ -f "cursor-mcp-config.json" ]; then
    cp cursor-mcp-config.json ~/.cursor/mcp-servers.json
    print_status "MCP configuration copied to Cursor"
else
    print_error "cursor-mcp-config.json not found in current directory"
    echo "Make sure you're running this script from the project root directory"
    exit 1
fi

# Verify setup
echo ""
print_info "Verifying setup..."

# Check Cursor configuration
if [ -f ~/.cursor/mcp-servers.json ]; then
    print_status "MCP configuration found in Cursor"
    echo "📊 Configured servers:"
    cat ~/.cursor/mcp-servers.json | grep -o '"[^"]*": {' | sed 's/": {//g' | sed 's/"//g' | sort | sed 's/^/  - /'
else
    print_error "MCP configuration not found in Cursor"
fi

# Final instructions
echo ""
echo "🎉 Setup Complete!"
echo "=================="
echo ""
print_info "Next Steps:"
echo "1. 🔄 Restart Cursor completely (Quit and reopen)"
echo "2. ⚙️  Open Cursor Settings (Cmd+, or Ctrl+,)"
echo "3. 🔍 Search for 'MCP' in settings"
echo "4. ✅ You should see your configured servers listed"
echo "5. 🧪 Test with commands like:"
echo "   - 'List my AWS resources using the core MCP server'"
echo "   - 'Show me my AWS costs for this month'"
echo "   - 'Read the package.json file'"
echo "   - 'Check git status'"
echo ""
print_info "Troubleshooting:"
echo "- If servers don't appear: Check Cursor's developer console (Cmd+Option+I)"
echo "- Look for MCP-related errors in the console"
echo "- Ensure uvx is in your PATH when Cursor starts"
echo "- Verify AWS credentials: aws sts get-caller-identity --profile wishy-profile"
echo ""
print_info "Your MCP servers are ready to use! 🚀" 