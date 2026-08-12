<p align="center">
  <img src="../../repo_assets/Claude.png" alt="ModelHitch Claude skills" width="100%"/>
</p>

# ModelHitch skills for Claude

[![Claude ready](https://img.shields.io/badge/Claude-ready-f28c28?style=for-the-badge)](./modelhitch-integrate/SKILL.md)
[![Two skills](https://img.shields.io/badge/skills-2-8bd600?style=for-the-badge)](#skills)
[![Agent Skills](https://img.shields.io/badge/Agent_Skills-portable-cc3f88?style=for-the-badge)](https://agentskills.io)

These project skills are built from ModelHitch source, types, and tests. Claude Code discovers
them automatically when working in this repository.

## Skills

| Skill | Purpose |
| --- | --- |
| [`/modelhitch-integrate`](./modelhitch-integrate/SKILL.md) | TypeScript, React, BYOK, providers, tools, and failover |
| [`/modelhitch-bridge`](./modelhitch-bridge/SKILL.md) | Claude Code, Codex, Gemini, IDE, and bridge operations |

## Reuse

Copy either skill directory into another project's `.claude/skills/` directory or into
`~/.claude/skills/` for personal use. Each skill directory can also be zipped individually for
Claude.ai upload.

The application library supports Node.js 18+. The packaged ModelHitch bridge requires Node.js
22.5+ because SQLite usage persistence is enabled.
