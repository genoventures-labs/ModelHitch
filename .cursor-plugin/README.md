<p align="center">
  <img src="../repo_assets/Cursor.png" alt="ModelHitch Cursor plugin and skills" width="100%"/>
</p>

# ModelHitch for Cursor

Fastest personal skill install:

```bash
npx modelhitch setup cursor
```

[![Cursor ready](https://img.shields.io/badge/Cursor-ready-f28c28?style=for-the-badge)](../plugins/modelhitch/README.md)
[![Plugin](https://img.shields.io/badge/plugin-included-cc3f88?style=for-the-badge)](../plugins/modelhitch/.cursor-plugin/plugin.json)
[![Skill](https://img.shields.io/badge/skill-included-8bd600?style=for-the-badge)](../plugins/modelhitch/skills/modelhitch/SKILL.md)

This directory is the Cursor multi-plugin marketplace entrypoint. The catalog resolves the
ModelHitch package under `plugins/modelhitch/`, where Cursor loads its manifest and the shared
skill.

## Local development

```bash
cursor-agent --plugin-dir ./plugins/modelhitch
```

For the Cursor IDE, copy the plugin directory to `~/.cursor/plugins/local/modelhitch`, then run
**Developer: Reload Window**.

## Publish

Submit the public repository through the
[Cursor Marketplace publisher](https://cursor.com/marketplace/publish). Cursor reviews every
marketplace plugin before listing it.
