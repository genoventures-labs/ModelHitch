<p align="center">
  <img src="../../repo_assets/Codex.png" alt="ModelHitch Codex plugin and skills" width="100%"/>
</p>

# ModelHitch for Codex

Fastest personal install:

```bash
npx modelhitch setup codex
```

[![Codex ready](https://img.shields.io/badge/Codex-ready-8757e5?style=for-the-badge)](../../plugins/modelhitch/README.md)
[![Plugin](https://img.shields.io/badge/plugin-included-cc3f88?style=for-the-badge)](../../plugins/modelhitch/.codex-plugin/plugin.json)
[![Skill](https://img.shields.io/badge/skill-included-8bd600?style=for-the-badge)](../../plugins/modelhitch/skills/modelhitch/SKILL.md)

This directory is the Codex marketplace entrypoint for the repository. It points Codex at the
shared package in `plugins/modelhitch/`.

## Install

```bash
codex plugin marketplace add genoventures-labs/ModelHitch
codex plugin add modelhitch@modelhitch
```

Start a new Codex task after installation so the plugin and its skill are loaded.

## Files

- `marketplace.json` — repository marketplace catalog
- `../../plugins/modelhitch/.codex-plugin/plugin.json` — Codex plugin metadata
- `../../plugins/modelhitch/skills/modelhitch/` — shared source-backed skill
