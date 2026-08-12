<p align="center">
  <img src="../../../repo_assets/Codex.png" alt="ModelHitch Codex plugin and skills" width="100%"/>
</p>

# Codex manifest

[`plugin.json`](./plugin.json) is the Codex presentation manifest for ModelHitch. It supplies the
listing metadata, starter prompts, and shared `skills/` path used when the plugin is installed from
the repository marketplace.

```bash
codex plugin marketplace add genoventures-labs/ModelHitch
codex plugin add modelhitch@modelhitch
```

The canonical skill lives at [`../skills/modelhitch/`](../skills/modelhitch/SKILL.md). Keep its
instructions source-backed and validate this package with the official Codex plugin validator
after changing the manifest.
