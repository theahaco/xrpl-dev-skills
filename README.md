# XRPL Development Skill for AI Coding Agents

A comprehensive agent skill for modern XRP Ledger development, for Claude Code, Codex and other agents that load skills.

## Overview

This skill gives coding agents deep knowledge of the XRPL development ecosystem:

- **Client SDK**: `xrpl.js` (v5.x), `xrpl-py`, `xrpl4j`
- **Frontend**: `xrpl-connect` wallet toolkit (Xaman, Crossmark, GemWallet, WalletConnect, Ledger)
- **Tokens**: Issued currencies, TrustLines, Multi-Purpose Tokens (MPTs) with compliance controls (allow-list, lock, clawback, bans)
- **NFTs**: XLS-20 NFTokens — minting, trading, brokered sales
- **DEX & AMM**: Order book offers, AMM pools, cross-currency routing
- **Payments**: XRP and cross-currency payments, escrows, payment channels, checks
- **Interoperability**: Axelar bridge, XRPL EVM sidechain
- **Security**: Partial payment attacks, key management, reserve awareness, common vulnerabilities

## Installation

### Quick Install

```bash
npx skills add https://github.com/XRPL-Commons/xrpl-dev-skills
```

### Manual Install

```bash
git clone https://github.com/XRPL-Commons/xrpl-dev-skills
cd xrpl-dev-skills
./install.sh            # Claude Code: ~/.claude/skills/xrpl-dev
./install.sh --agents   # Codex and other agents: ~/.agents/skills/xrpl-dev
```

Add `--project` to install into the current project (`.claude/skills/xrpl-dev` or `.agents/skills/xrpl-dev`) instead of your home directory. Codex does not read `.claude/skills`, so Codex users need `--agents`.

## Skill Structure

```
skill/
├── SKILL.md                 # Main skill definition (required)
├── client-sdk.md            # Connection, accounts, tx lifecycle, signing, querying
├── frontend.md              # Wallet connection, React patterns, tx signing UX
├── tokens.md                # Issued currencies, TrustLines, MPT overview
├── mpt.md                   # MPTs: issue, authorize, pay, read back, lock, clawback, ban
├── nfts.md                  # XLS-20 NFTokens
├── dex-amm.md               # Order book + AMM
├── payments.md              # XRP payments, cross-currency, escrows, channels, checks
├── interoperability.md      # Axelar bridge, XRPL EVM sidechain interop
├── security.md              # Vulnerability patterns and prevention
└── resources.md             # Curated reference links
```

## Usage

Once installed, your agent will use this skill when you ask about:

- XRPL dApp development
- Wallet connection and signing flows
- Transaction building, signing, and submission
- Token issuance and management, including MPT compliance controls
- NFT minting and trading
- DEX/AMM interactions
- Cross-chain interoperability
- Security reviews

### Example Prompts

```
"Help me set up a Next.js app with XRPL wallet connection"
"Create a token issuance flow with TrustLines"
"Build an NFT marketplace with brokered sales"
"How do I swap tokens using the AMM?"
"Bridge assets from XRPL to EVM sidechain via Axelar"
"Review this integration for partial payment vulnerabilities"
```

## Progressive Disclosure

The skill uses progressive disclosure. The main `SKILL.md` provides core guidance, and the agent reads the specialized markdown files only when a task needs them.

## Contributing

Contributions are welcome! Please ensure any updates reflect current XRPL ecosystem best practices.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.
