// src/agents/generated-agents.ts
//
// GENERATED FILE — do not edit by hand.
// Regenerate: node scripts/extract-agent-table.mjs <path-to-skills/dist/cli.mjs>
//
// Source:     npm package `skills` (https://github.com/vercel-labs/skills)
// Version:    1.5.23
// SHA-256:    343668347d50a885b47187091314ecc8fc7ee7584bfdf724ccee34d587da7dd3
// Extracted:  2026-08-31
// Entries:    76 agents, 73 with a resolvable global skill root,
//             63 with an install-detection path
//
// The source file lives inside an npm package, not at a stable path on any machine;
// fetch it with `npm pack skills@1.5.23` to re-derive and diff this table.
//
// Every entry here is `sourced`: taken from a third-party table and never verified by
// peek. Corrections belong in the overlay in ./builtin.ts, which wins over this file, so
// a regeneration cannot silently revert them.
import type { GeneratedAgent } from "./types.js";

export const GENERATED_SOURCE = {
  package: "skills",
  version: "1.5.23",
  sha256: "343668347d50a885b47187091314ecc8fc7ee7584bfdf724ccee34d587da7dd3",
  extracted: "2026-08-31",
} as const;

export const GENERATED_AGENTS: GeneratedAgent[] = [
  {
    "slug": "adal",
    "displayName": "AdaL",
    "projectDir": ".adal/skills",
    "globalRoot": "{home}/.adal/skills",
    "detectPaths": [
      "{home}/.adal"
    ]
  },
  {
    "slug": "aider-desk",
    "displayName": "AiderDesk",
    "projectDir": ".aider-desk/skills",
    "globalRoot": "{home}/.aider-desk/skills",
    "detectPaths": [
      "{home}/.aider-desk"
    ]
  },
  {
    "slug": "amp",
    "displayName": "Amp",
    "projectDir": ".agents/skills",
    "globalRoot": "{config}/agents/skills",
    "detectPaths": [
      "{config}/amp"
    ]
  },
  {
    "slug": "antigravity",
    "displayName": "Antigravity",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.gemini/antigravity/skills",
    "detectPaths": [
      "{home}/.gemini/antigravity"
    ]
  },
  {
    "slug": "antigravity-cli",
    "displayName": "Antigravity CLI",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.gemini/antigravity-cli/skills",
    "detectPaths": [
      "{home}/.gemini/antigravity-cli"
    ]
  },
  {
    "slug": "astrbot",
    "displayName": "AstrBot",
    "projectDir": "data/skills",
    "globalRoot": "{home}/.astrbot/data/skills",
    "detectPaths": [
      "{home}/.astrbot"
    ]
  },
  {
    "slug": "augment",
    "displayName": "Augment",
    "projectDir": ".augment/skills",
    "globalRoot": "{home}/.augment/skills",
    "detectPaths": [
      "{home}/.augment"
    ]
  },
  {
    "slug": "autohand-code",
    "displayName": "Autohand Code CLI",
    "projectDir": ".autohand/skills",
    "globalRoot": "{autohand}/skills"
  },
  {
    "slug": "bob",
    "displayName": "IBM Bob",
    "projectDir": ".bob/skills",
    "globalRoot": "{home}/.bob/skills",
    "detectPaths": [
      "{home}/.bob"
    ]
  },
  {
    "slug": "claude-code",
    "displayName": "Claude Code",
    "projectDir": ".claude/skills",
    "globalRoot": "{claude}/skills"
  },
  {
    "slug": "cline",
    "displayName": "Cline",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.agents/skills",
    "detectPaths": [
      "{home}/.cline"
    ]
  },
  {
    "slug": "codearts-agent",
    "displayName": "CodeArts Agent",
    "projectDir": ".codeartsdoer/skills",
    "globalRoot": "{home}/.codeartsdoer/skills",
    "detectPaths": [
      "{home}/.codeartsdoer"
    ]
  },
  {
    "slug": "codebuddy",
    "displayName": "CodeBuddy",
    "projectDir": ".codebuddy/skills",
    "globalRoot": "{home}/.codebuddy/skills",
    "detectPaths": [
      "{home}/.codebuddy"
    ]
  },
  {
    "slug": "codemaker",
    "displayName": "Codemaker",
    "projectDir": ".codemaker/skills",
    "globalRoot": "{home}/.codemaker/skills",
    "detectPaths": [
      "{home}/.codemaker"
    ]
  },
  {
    "slug": "codestudio",
    "displayName": "Code Studio",
    "projectDir": ".codestudio/skills",
    "globalRoot": "{home}/.codestudio/skills",
    "detectPaths": [
      "{home}/.codestudio"
    ]
  },
  {
    "slug": "codex",
    "displayName": "Codex",
    "projectDir": ".agents/skills",
    "globalRoot": "{codex}/skills"
  },
  {
    "slug": "command-code",
    "displayName": "Command Code",
    "projectDir": ".commandcode/skills",
    "globalRoot": "{home}/.commandcode/skills",
    "detectPaths": [
      "{home}/.commandcode"
    ]
  },
  {
    "slug": "continue",
    "displayName": "Continue",
    "projectDir": ".continue/skills",
    "globalRoot": "{home}/.continue/skills",
    "detectPaths": [
      "{home}/.continue"
    ]
  },
  {
    "slug": "cortex",
    "displayName": "Cortex Code",
    "projectDir": ".cortex/skills",
    "globalRoot": "{home}/.snowflake/cortex/skills",
    "detectPaths": [
      "{home}/.snowflake/cortex"
    ]
  },
  {
    "slug": "crush",
    "displayName": "Crush",
    "projectDir": ".crush/skills",
    "globalRoot": "{home}/.config/crush/skills",
    "detectPaths": [
      "{home}/.config/crush"
    ]
  },
  {
    "slug": "cursor",
    "displayName": "Cursor",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.cursor/skills",
    "detectPaths": [
      "{home}/.cursor"
    ]
  },
  {
    "slug": "deepagents",
    "displayName": "Deep Agents",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.deepagents/agent/skills",
    "detectPaths": [
      "{home}/.deepagents"
    ]
  },
  {
    "slug": "devin",
    "displayName": "Devin for Terminal",
    "projectDir": ".devin/skills",
    "globalRoot": "{config}/devin/skills",
    "detectPaths": [
      "{config}/devin"
    ]
  },
  {
    "slug": "dexto",
    "displayName": "Dexto",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.agents/skills",
    "detectPaths": [
      "{home}/.dexto"
    ]
  },
  {
    "slug": "droid",
    "displayName": "Droid",
    "projectDir": ".factory/skills",
    "globalRoot": "{home}/.factory/skills",
    "detectPaths": [
      "{home}/.factory"
    ]
  },
  {
    "slug": "eve",
    "displayName": "Eve",
    "projectDir": "agent/skills"
  },
  {
    "slug": "firebender",
    "displayName": "Firebender",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.firebender/skills",
    "detectPaths": [
      "{home}/.firebender"
    ]
  },
  {
    "slug": "forgecode",
    "displayName": "ForgeCode",
    "projectDir": ".forge/skills",
    "globalRoot": "{home}/.forge/skills",
    "detectPaths": [
      "{home}/.forge"
    ]
  },
  {
    "slug": "gemini-cli",
    "displayName": "Gemini CLI",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.gemini/skills",
    "detectPaths": [
      "{home}/.gemini"
    ]
  },
  {
    "slug": "github-copilot",
    "displayName": "GitHub Copilot",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.copilot/skills",
    "detectPaths": [
      "{home}/.copilot"
    ]
  },
  {
    "slug": "goose",
    "displayName": "Goose",
    "projectDir": ".goose/skills",
    "globalRoot": "{config}/goose/skills",
    "detectPaths": [
      "{config}/goose"
    ]
  },
  {
    "slug": "grok",
    "displayName": "Grok Build",
    "projectDir": ".grok/skills",
    "globalRoot": "{grok}/skills"
  },
  {
    "slug": "hermes-agent",
    "displayName": "Hermes Agent",
    "projectDir": ".hermes/skills",
    "globalRoot": "{hermes}/skills"
  },
  {
    "slug": "iflow-cli",
    "displayName": "iFlow CLI",
    "projectDir": ".iflow/skills",
    "globalRoot": "{home}/.iflow/skills",
    "detectPaths": [
      "{home}/.iflow"
    ]
  },
  {
    "slug": "inference-sh",
    "displayName": "inference.sh",
    "projectDir": ".inferencesh/skills",
    "globalRoot": "{home}/.inferencesh/skills",
    "detectPaths": [
      "{home}/.inferencesh"
    ]
  },
  {
    "slug": "jazz",
    "displayName": "Jazz",
    "projectDir": ".jazz/skills",
    "globalRoot": "{home}/.jazz/skills",
    "detectPaths": [
      "{home}/.jazz"
    ]
  },
  {
    "slug": "junie",
    "displayName": "Junie",
    "projectDir": ".junie/skills",
    "globalRoot": "{home}/.junie/skills",
    "detectPaths": [
      "{home}/.junie"
    ]
  },
  {
    "slug": "kilo",
    "displayName": "Kilo Code",
    "projectDir": ".kilocode/skills",
    "globalRoot": "{home}/.kilocode/skills",
    "detectPaths": [
      "{home}/.kilocode"
    ]
  },
  {
    "slug": "kimchi",
    "displayName": "Kimchi",
    "projectDir": ".kimchi/skills",
    "globalRoot": "{home}/.config/kimchi/harness/skills"
  },
  {
    "slug": "kimi-code-cli",
    "displayName": "Kimi Code CLI",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.agents/skills",
    "detectPaths": [
      "{home}/.kimi-code",
      "{home}/.kimi"
    ]
  },
  {
    "slug": "kiro-cli",
    "displayName": "Kiro CLI",
    "projectDir": ".kiro/skills",
    "globalRoot": "{home}/.kiro/skills",
    "detectPaths": [
      "{home}/.kiro"
    ]
  },
  {
    "slug": "kode",
    "displayName": "Kode",
    "projectDir": ".kode/skills",
    "globalRoot": "{home}/.kode/skills",
    "detectPaths": [
      "{home}/.kode"
    ]
  },
  {
    "slug": "lingma",
    "displayName": "Lingma",
    "projectDir": ".lingma/skills",
    "globalRoot": "{home}/.lingma/skills",
    "detectPaths": [
      "{home}/.lingma"
    ]
  },
  {
    "slug": "loaf",
    "displayName": "Loaf",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.agents/skills",
    "detectPaths": [
      "{home}/.loaf"
    ]
  },
  {
    "slug": "mcpjam",
    "displayName": "MCPJam",
    "projectDir": ".mcpjam/skills",
    "globalRoot": "{home}/.mcpjam/skills",
    "detectPaths": [
      "{home}/.mcpjam"
    ]
  },
  {
    "slug": "minimax-code",
    "displayName": "MiniMax Code",
    "projectDir": ".minimax/skills",
    "globalRoot": "{home}/.minimax/skills"
  },
  {
    "slug": "mistral-vibe",
    "displayName": "Mistral Vibe",
    "projectDir": ".vibe/skills",
    "globalRoot": "{vibe}/skills"
  },
  {
    "slug": "moxby",
    "displayName": "Moxby",
    "projectDir": ".moxby/skills",
    "globalRoot": "{home}/.moxby/skills",
    "detectPaths": [
      "{home}/.moxby"
    ]
  },
  {
    "slug": "mux",
    "displayName": "Mux",
    "projectDir": ".mux/skills",
    "globalRoot": "{home}/.mux/skills",
    "detectPaths": [
      "{home}/.mux"
    ]
  },
  {
    "slug": "neovate",
    "displayName": "Neovate",
    "projectDir": ".neovate/skills",
    "globalRoot": "{home}/.neovate/skills",
    "detectPaths": [
      "{home}/.neovate"
    ]
  },
  {
    "slug": "ona",
    "displayName": "Ona",
    "projectDir": ".ona/skills",
    "globalRoot": "{home}/.ona/skills",
    "detectPaths": [
      "{home}/.ona"
    ]
  },
  {
    "slug": "openclaw",
    "displayName": "OpenClaw",
    "projectDir": "skills",
    "detectPaths": [
      "{home}/.openclaw",
      "{home}/.clawdbot",
      "{home}/.moltbot"
    ]
  },
  {
    "slug": "opencode",
    "displayName": "OpenCode",
    "projectDir": ".agents/skills",
    "globalRoot": "{config}/opencode/skills",
    "detectPaths": [
      "{config}/opencode"
    ]
  },
  {
    "slug": "openhands",
    "displayName": "OpenHands",
    "projectDir": ".openhands/skills",
    "globalRoot": "{home}/.openhands/skills",
    "detectPaths": [
      "{home}/.openhands"
    ]
  },
  {
    "slug": "pi",
    "displayName": "Pi",
    "projectDir": ".pi/skills",
    "globalRoot": "{home}/.pi/agent/skills",
    "detectPaths": [
      "{home}/.pi/agent"
    ]
  },
  {
    "slug": "pochi",
    "displayName": "Pochi",
    "projectDir": ".pochi/skills",
    "globalRoot": "{home}/.pochi/skills",
    "detectPaths": [
      "{home}/.pochi"
    ]
  },
  {
    "slug": "posit-assistant",
    "displayName": "Posit Assistant",
    "projectDir": ".posit/assistant/skills",
    "globalRoot": "{home}/.posit/assistant/skills"
  },
  {
    "slug": "promptscript",
    "displayName": "PromptScript",
    "projectDir": ".agents/skills"
  },
  {
    "slug": "qoder",
    "displayName": "Qoder",
    "projectDir": ".qoder/skills",
    "globalRoot": "{home}/.qoder/skills",
    "detectPaths": [
      "{home}/.qoder"
    ]
  },
  {
    "slug": "qoder-cn",
    "displayName": "Qoder CN",
    "projectDir": ".qoder/skills",
    "globalRoot": "{home}/.qoder-cn/skills",
    "detectPaths": [
      "{home}/.qoder-cn"
    ]
  },
  {
    "slug": "qwen-code",
    "displayName": "Qwen Code",
    "projectDir": ".qwen/skills",
    "globalRoot": "{home}/.qwen/skills",
    "detectPaths": [
      "{home}/.qwen"
    ]
  },
  {
    "slug": "reasonix",
    "displayName": "Reasonix",
    "projectDir": ".reasonix/skills",
    "globalRoot": "{home}/.reasonix/skills",
    "detectPaths": [
      "{home}/.reasonix"
    ]
  },
  {
    "slug": "replit",
    "displayName": "Replit",
    "projectDir": ".agents/skills",
    "globalRoot": "{config}/agents/skills"
  },
  {
    "slug": "roo",
    "displayName": "Roo Code",
    "projectDir": ".roo/skills",
    "globalRoot": "{home}/.roo/skills",
    "detectPaths": [
      "{home}/.roo"
    ]
  },
  {
    "slug": "rovodev",
    "displayName": "Rovo Dev",
    "projectDir": ".rovodev/skills",
    "globalRoot": "{home}/.rovodev/skills",
    "detectPaths": [
      "{home}/.rovodev"
    ]
  },
  {
    "slug": "tabnine-cli",
    "displayName": "Tabnine CLI",
    "projectDir": ".tabnine/agent/skills",
    "globalRoot": "{home}/.tabnine/agent/skills",
    "detectPaths": [
      "{home}/.tabnine"
    ]
  },
  {
    "slug": "terramind",
    "displayName": "Terramind",
    "projectDir": ".terramind/skills",
    "globalRoot": "{home}/.terramind/skills",
    "detectPaths": [
      "{home}/.terramind"
    ]
  },
  {
    "slug": "tinycloud",
    "displayName": "Tinycloud",
    "projectDir": ".tinycloud/skills",
    "globalRoot": "{home}/.tinycloud/skills",
    "detectPaths": [
      "{home}/.tinycloud"
    ]
  },
  {
    "slug": "trae",
    "displayName": "Trae",
    "projectDir": ".trae/skills",
    "globalRoot": "{home}/.trae/skills",
    "detectPaths": [
      "{home}/.trae"
    ]
  },
  {
    "slug": "trae-cn",
    "displayName": "Trae CN",
    "projectDir": ".trae/skills",
    "globalRoot": "{home}/.trae-cn/skills",
    "detectPaths": [
      "{home}/.trae-cn"
    ]
  },
  {
    "slug": "warp",
    "displayName": "Warp",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.agents/skills",
    "detectPaths": [
      "{home}/.warp"
    ]
  },
  {
    "slug": "windsurf",
    "displayName": "Windsurf",
    "projectDir": ".windsurf/skills",
    "globalRoot": "{home}/.codeium/windsurf/skills",
    "detectPaths": [
      "{home}/.codeium/windsurf"
    ]
  },
  {
    "slug": "zcode",
    "displayName": "ZCode",
    "projectDir": ".zcode/skills",
    "globalRoot": "{home}/.zcode/skills"
  },
  {
    "slug": "zed",
    "displayName": "Zed",
    "projectDir": ".agents/skills",
    "globalRoot": "{home}/.agents/skills",
    "detectPaths": [
      "{config}/zed"
    ]
  },
  {
    "slug": "zencoder",
    "displayName": "Zencoder",
    "projectDir": ".zencoder/skills",
    "globalRoot": "{home}/.zencoder/skills",
    "detectPaths": [
      "{home}/.zencoder"
    ]
  },
  {
    "slug": "zenflow",
    "displayName": "Zenflow",
    "projectDir": ".zencoder/skills",
    "globalRoot": "{home}/.zencoder/skills",
    "detectPaths": [
      "{home}/.zencoder"
    ]
  }
];
