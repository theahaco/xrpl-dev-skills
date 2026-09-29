#!/bin/bash

# XRPL Dev Skill Installer for Claude Code, Codex and other agents
# Usage: ./install.sh [--agents] [--project | --path <path>]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_NAME="xrpl-dev"
SOURCE_DIR="$SCRIPT_DIR/skill"

# Claude Code reads .claude/skills; Codex and other agents read .agents/skills.
SKILLS_DIR=".claude/skills"
AGENT_NAME="Claude Code"
PROJECT=false
CUSTOM_PATH=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --agents)
            SKILLS_DIR=".agents/skills"
            AGENT_NAME="Codex and other agents that read .agents/skills"
            shift
            ;;
        --project)
            PROJECT=true
            shift
            ;;
        --path)
            CUSTOM_PATH="$2"
            shift 2
            ;;
        -h|--help)
            echo "XRPL Dev Skill Installer"
            echo ""
            echo "Usage: ./install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --agents      Install for Codex and other agents (.agents/skills instead of .claude/skills)"
            echo "  --project     Install to current project (./<skills dir>/$SKILL_NAME)"
            echo "  --path PATH   Install to custom path"
            echo "  -h, --help    Show this help message"
            echo ""
            echo "Default: Install to ~/.claude/skills/$SKILL_NAME for Claude Code."
            echo "With --agents: ~/.agents/skills/$SKILL_NAME, or ./.agents/skills/$SKILL_NAME with --project."
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

if [ -n "$CUSTOM_PATH" ]; then
    INSTALL_PATH="$CUSTOM_PATH"
elif [ "$PROJECT" = true ]; then
    INSTALL_PATH="$SKILLS_DIR/$SKILL_NAME"
else
    INSTALL_PATH="$HOME/$SKILLS_DIR/$SKILL_NAME"
fi

# Check if source directory exists
if [ ! -d "$SOURCE_DIR" ]; then
    echo "Error: Source directory '$SOURCE_DIR' not found"
    exit 1
fi

# Check if SKILL.md exists
if [ ! -f "$SOURCE_DIR/SKILL.md" ]; then
    echo "Error: SKILL.md not found in '$SOURCE_DIR'"
    exit 1
fi

# Create parent directory if needed
mkdir -p "$(dirname "$INSTALL_PATH")"

# Check if destination already exists
if [ -d "$INSTALL_PATH" ]; then
    echo "Warning: '$INSTALL_PATH' already exists"
    read -p "Overwrite? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Installation cancelled"
        exit 0
    fi
    rm -rf "$INSTALL_PATH"
fi

# Copy skill files
echo "Installing XRPL Dev Skill..."
cp -r "$SOURCE_DIR" "$INSTALL_PATH"

echo ""
echo "Successfully installed to: $INSTALL_PATH"
echo ""
echo "Installed files:"
find "$INSTALL_PATH" -type f -name "*.md" | while read -r file; do
    echo "  - $(basename "$file")"
done
echo ""
echo "The skill is now available to $AGENT_NAME."
echo "Try asking about XRPL development to activate it!"
