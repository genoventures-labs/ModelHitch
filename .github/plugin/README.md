<p align="center">
  <img src="../../repo_assets/VSCode.png" alt="ModelHitch VS Code and GitHub Copilot plugin and skills" width="100%"/>
</p>

# ModelHitch for VS Code and GitHub Copilot

[![VS Code ready](https://img.shields.io/badge/VS_Code-ready-2296f3?style=for-the-badge)](../../plugins/modelhitch/README.md)
[![Agent Plugins 1.0](https://img.shields.io/badge/Agent_Plugins-1.0-cc3f88?style=for-the-badge)](../../plugins/modelhitch/plugin.json)
[![Skill](https://img.shields.io/badge/skill-included-8bd600?style=for-the-badge)](../../plugins/modelhitch/skills/modelhitch/SKILL.md)

This is the GitHub Copilot marketplace entrypoint. It distributes the portable Agent Plugins 1.0
package in `plugins/modelhitch/` to Copilot CLI, GitHub Copilot in VS Code, and Copilot cloud
agent.

## Install

```bash
copilot plugin marketplace add genoventures-labs/ModelHitch
copilot plugin install modelhitch@modelhitch
```

VS Code automatically discovers plugins installed by Copilot CLI. Alternatively, use
**Chat: Install Plugin From Source** and provide this repository URL.

When working inside the ModelHitch repository, VS Code also discovers the project skills under
`.claude/skills/` directly.
