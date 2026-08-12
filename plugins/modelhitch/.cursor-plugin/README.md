<p align="center">
  <img src="../../../repo_assets/Cursor.png" alt="ModelHitch Cursor plugin and skills" width="100%"/>
</p>

# Cursor manifest

[`plugin.json`](./plugin.json) is the Cursor presentation manifest for ModelHitch. Cursor resolves
the shared skill under [`../skills/modelhitch/`](../skills/modelhitch/SKILL.md), so the agent
guidance stays aligned with the Codex and portable Agent Plugins packages.

Test the package directly from the repository:

```bash
cursor-agent --plugin-dir ./plugins/modelhitch
```

The root [Cursor marketplace](../../../.cursor-plugin/marketplace.json) maps the public repository
listing to this plugin directory.
