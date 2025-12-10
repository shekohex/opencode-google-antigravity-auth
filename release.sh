#!/usr/bin/env bash

# release.sh - Automate NPM package release via GitHub Actions
# 
# Usage: ./release.sh [options]
# 
# Options:
#   --patch         Bump patch version (default)
#   --minor         Bump minor version
#   --major         Bump major version
#   --dry-run       Simulate the release process without making changes
#   --yes, -y       Skip confirmation prompt before pushing
#   --help, -h      Show this help message

set -euo pipefail

# --- Configuration & State ---
DRY_RUN=false
SKIP_CONFIRM=false
BUMP_TYPE="patch"
SCRIPT_NAME=$(basename "$0")

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# --- Helper Functions ---

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

cleanup() {
    # Any cleanup code if necessary
    :
}

# Set trap
trap cleanup EXIT

usage() {
    grep "^# " "$0" | cut -c 3-
}

# --- Argument Parsing ---

while [[ $# -gt 0 ]]; do
    case "$1" in
        --patch)
            BUMP_TYPE="patch"
            shift
            ;;
        --minor)
            BUMP_TYPE="minor"
            shift
            ;;
        --major)
            BUMP_TYPE="major"
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --yes|-y)
            SKIP_CONFIRM=true
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

# --- Main Logic ---

log_info "Starting release process..."
log_info "Mode: ${BUMP_TYPE}"
if [ "$DRY_RUN" = true ]; then
    log_warn "DRY RUN MODE: No changes will be applied."
fi

# 1. Check dependencies
if ! command -v bun &> /dev/null; then
    log_error "bun is required but not installed."
    exit 1
fi

if ! command -v git &> /dev/null; then
    log_error "git is required but not installed."
    exit 1
fi

if ! command -v npm &> /dev/null; then
    log_error "npm is required but not installed."
    exit 1
fi

# 2. Check Git Status
log_info "Checking git status..."
if [ -n "$(git status --porcelain)" ]; then
    log_error "Git working directory is not clean. Please commit or stash changes first."
    exit 1
fi

# 3. Get Current Version using Bun
CURRENT_VERSION=$(bun -e 'import pkg from "./package.json"; console.log(pkg.version)')
log_info "Current version: v$CURRENT_VERSION"

# 4. Bump Version
if [ "$DRY_RUN" = true ]; then
    log_info "[DRY-RUN] Would run: npm version $BUMP_TYPE --no-git-tag-version"
    # Estimate next version for display (naive approximation)
    log_info "[DRY-RUN] Would bump version ($BUMP_TYPE)"
else
    # npm version returns the new version string like "v1.0.1"
    NEW_VERSION_TAG=$(npm version "$BUMP_TYPE" --no-git-tag-version)
    # Remove 'v' prefix for consistency if needed, though npm version returns with v
    NEW_VERSION=${NEW_VERSION_TAG#v}
    log_success "Bumped version to: $NEW_VERSION"
fi

# 5. Extract New Version for Commit (if we didn't just capture it above, or to be double safe)
if [ "$DRY_RUN" = true ]; then
    # Fake it for dry run
    NEW_VERSION="x.y.z"
else
    # Re-read using Bun to confirm the file update
    NEW_VERSION=$(bun -e 'import pkg from "./package.json"; console.log(pkg.version)')
fi

COMMIT_MSG="chore: release $NEW_VERSION"

# 6. Commit Changes
if [ "$DRY_RUN" = true ]; then
    log_info "[DRY-RUN] Would run: git add package.json"
    log_info "[DRY-RUN] Would run: git commit -m \"$COMMIT_MSG\""
else
    git add package.json
    git commit -m "$COMMIT_MSG"
    log_success "Commited changes: $COMMIT_MSG"
fi

# 7. Push to Main
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [ "$CURRENT_BRANCH" != "main" ]; then
    log_warn "You are on branch '$CURRENT_BRANCH', not 'main'. The release workflow triggers on 'main'."
fi

if [ "$DRY_RUN" = true ]; then
    log_info "[DRY-RUN] Would prompt for confirmation (unless -y) and push to origin $CURRENT_BRANCH"
else
    if [ "$SKIP_CONFIRM" = false ]; then
        log_warn "Ready to push to origin $CURRENT_BRANCH. This will trigger the GitHub Action release workflow."
        read -p "Are you sure you want to proceed? [Y/n] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Release cancelled by user."
            # Optional: revert the version bump? 
            # For safety in this simple script, we leave it as is, but user can git reset.
            log_warn "Note: package.json version was bumped. Use 'git reset --hard HEAD^' to undo if needed."
            exit 0
        fi
    fi

    log_info "Pushing to origin..."
    git push origin "$CURRENT_BRANCH"
    log_success "Pushed successfully!"
    log_info "GitHub Actions should now handle the release."
fi
