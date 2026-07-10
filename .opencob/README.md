# OpenCob Configuration (`.opencob/`)

This directory contains project-specific configurations and instructions for the OpenCob AI coding assistant. It allows you to customize the agent's behavior, define custom modes, and provide specific guidance for different parts of your codebase.

By placing this folder in the root of your repository, you ensure that every developer using OpenCob has a consistent, optimized experience tailored to your project's needs.

## Directory Structure

- **`README.md`**: This file. It provides an overview of the `.opencob` directory.
- **`.gitignore`**: Ensures user-specific files (like `conversations.json`) are not committed to the repository.
- **`opencob-instructions.md`**: The primary system prompt for the agent. This file contains high-level instructions, conventions, and rules that the agent should follow for the entire project.
- **`custom_modes.json`**: Defines custom "modes" that control which tools the agent can use. This is powerful for creating safe, role-based behaviors (e.g., a "read-only" mode for analysis vs. a "full-access" mode for development).
- **`mcp-servers.json`**: Configures connections to Model Context Protocol (MCP) servers, which can provide external context to the agent (e.g., documentation, legacy code analysis).
- **`instructions/`**: A directory for granular, file-specific instructions. The agent will apply instructions from a file in this directory if the file it's working on matches the glob pattern in the filename.
  - `typescript.instructions.md`: An example of file-specific instructions, applied to all TypeScript files.
- **`hooks/`**: Contains scripts or markdown files that can be triggered by agent events. This is an advanced feature for automating parts of the development workflow.
  - `test-reminder.md`: An example hook.

## How It Works

When OpenCob starts in a workspace, it detects the `.opencob` directory and loads its contents.

1.  **`opencob-instructions.md`** is loaded as the base system prompt.
2.  **`custom_modes.json`** and **`mcp-servers.json`** are parsed to configure the agent's capabilities and context sources.
3.  When you interact with the agent, it consults the **`instructions/`** directory. If the active file matches a pattern (e.g., `*.ts`), the corresponding instructions are dynamically added to the prompt.
4.  **`hooks/`** can be used to trigger actions at different points in the agent's lifecycle.

This layered approach allows for powerful and precise control over the AI's behavior, ensuring it aligns perfectly with your project's architecture and conventions.

## Community-Ready Defaults

This directory is designed to be safe to commit and share:

- User-local history is excluded via `.gitignore`.
- Base project rules live in `opencob-instructions.md`.
- File-targeted standards live under `instructions/` using `applyTo` globs.
- Event-driven nudges (like test reminders) live under `hooks/`.
- Optional MCP integrations are centrally declared in `mcp-servers.json`.

## Maintainer Checklist

Use this checklist before merging updates to `.opencob/`:

1. Verify all `applyTo` patterns match the actual monorepo layout.
2. Keep JSON files valid (no comments, no trailing commas).
3. Ensure instructions do not conflict with root repository guidance.
4. Confirm hooks are actionable and do not create noisy, low-value reminders.
5. If adding MCP servers, document ownership, auth method, and expected data scope.

## Validation

Run config validation locally before opening a PR:

```bash
pnpm validate:opencob
```

This command validates JSON structure, required files, and markdown frontmatter
for `.opencob/instructions` and `.opencob/hooks`. The same check runs in CI.

## MCP Server Notes

`mcp-servers.json` intentionally starts with an empty object.
Add only vetted servers and prefer least-privilege settings. Example structure:

```json
{
  "mcpServers": {
    "example-server": {
      "command": "node",
      "args": ["./path/to/server.js"],
      "env": {
        "EXAMPLE_FLAG": "1"
      }
    }
  }
}
```
