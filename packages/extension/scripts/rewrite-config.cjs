const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

pkg.contributes.configuration = [
  {
    title: "Provider",
    order: 1,
    properties: {
      "OpenCob.model.provider": {
        type: "string",
        default: "ollama",
        order: 1,
        enum: ["ollama", "litellm", "openai", "azure", "anthropic", "gemini", "openai-compatible"],
        enumDescriptions: [
          "Local Ollama server \u2014 fully private, no data leaves your machine",
          "LiteLLM proxy \u2014 unified gateway to route to any LLM backend",
          "OpenAI API \u2014 GPT-4o, GPT-5, o1, o3, etc.",
          "Azure OpenAI Service \u2014 enterprise-grade with managed deployment",
          "Anthropic API \u2014 Claude Sonnet 4.5, Haiku 4.5, Opus 4",
          "Google Gemini API \u2014 Gemini 2.5 Flash and Pro",
          "Any custom OpenAI-compatible endpoint (vLLM, text-gen-webui, etc.)"
        ],
        markdownDescription: "Which LLM provider to use for inference. Only the settings for the selected provider are relevant.\n\n**Quick start:**\n- Local/private \u2192 `ollama`\n- Corporate proxy \u2192 `litellm`\n- Direct cloud API \u2192 `openai` / `azure` / `anthropic` / `gemini`"
      }
    }
  },
  {
    title: "Models",
    order: 2,
    properties: {
      "OpenCob.model.chat": {
        type: "string",
        default: "qwen2.5-coder:7b",
        order: 1,
        markdownDescription: "Model for **chat interactions** (agentic coding, Q&A, refactoring).\n\nClick the model name in the status bar or run `OpenCob: Select Model` to browse available models.\n\n**Examples by provider:**\n| Provider | Models |\n|----------|--------|\n| Ollama | `qwen2.5-coder:7b`, `deepseek-coder:6.7b` |\n| LiteLLM | `azure/gpt-5-mini-EU`, `anthropic-vertex-claude-sonnet-4-5` |\n| OpenAI | `gpt-4o`, `o1`, `gpt-5` |\n| Anthropic | `claude-sonnet-4-5-20250514` |\n| Gemini | `gemini-2.5-flash`, `gemini-2.5-pro` |"
      },
      "OpenCob.model.completion": {
        type: "string",
        default: "qwen2.5-coder:1.5b",
        order: 2,
        markdownDescription: "Model for **inline code completion** (FIM / ghost text). Should be a fast, small model for low latency.\n\n**Examples by provider:**\n| Provider | Models |\n|----------|--------|\n| Ollama | `qwen2.5-coder:1.5b`, `starcoder2:3b` |\n| LiteLLM | `azure/gpt-5-nano-EU` |\n| OpenAI | `gpt-4o-mini` |\n| Anthropic | `claude-haiku-4-5-20250514` |\n| Gemini | `gemini-2.5-flash` |"
      },
      "OpenCob.model.embedding": {
        type: "string",
        default: "nomic-embed-text",
        order: 3,
        markdownDescription: "Model for **text embeddings** (workspace indexing & semantic search).\n\n**Examples:** `nomic-embed-text`, `text-embedding-3-small`, `mxbai-embed-large`"
      }
    }
  },
  {
    title: "Ollama",
    order: 3,
    properties: {
      "OpenCob.ollama.baseUrl": {
        type: "string",
        default: "http://127.0.0.1:11434",
        markdownDescription: "Ollama server URL. **Only used when provider is `ollama`.**\n\nStart Ollama with `ollama serve` before using."
      }
    }
  },
  {
    title: "LiteLLM Proxy",
    order: 4,
    properties: {
      "OpenCob.litellm.baseUrl": {
        type: "string",
        default: "http://127.0.0.1:4000",
        markdownDescription: "LiteLLM proxy URL. **Only used when provider is `litellm`.**\n\nLiteLLM acts as a unified proxy to route requests to any backend (Azure, AWS Bedrock, Vertex AI, etc.)."
      },
      "OpenCob.litellm.apiKey": {
        type: "string",
        default: "",
        markdownDescription: "Bearer token for authenticating with the LiteLLM proxy. Leave empty if your proxy doesn\u2019t require auth."
      }
    }
  },
  {
    title: "OpenAI",
    order: 5,
    properties: {
      "OpenCob.openai.baseUrl": {
        type: "string",
        default: "https://api.openai.com",
        markdownDescription: "OpenAI API base URL. **Only used when provider is `openai`.**"
      },
      "OpenCob.openai.apiKey": {
        type: "string",
        default: "",
        markdownDescription: "Your OpenAI API key. Get one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)."
      }
    }
  },
  {
    title: "Azure OpenAI",
    order: 6,
    properties: {
      "OpenCob.azure.baseUrl": {
        type: "string",
        default: "",
        markdownDescription: "Azure OpenAI endpoint. **Only used when provider is `azure`.**\n\nFormat: `https://{resource-name}.openai.azure.com`"
      },
      "OpenCob.azure.apiKey": {
        type: "string",
        default: "",
        markdownDescription: "Azure OpenAI API key from your Azure Portal resource."
      }
    }
  },
  {
    title: "Anthropic (Claude)",
    order: 7,
    properties: {
      "OpenCob.anthropic.baseUrl": {
        type: "string",
        default: "https://api.anthropic.com",
        markdownDescription: "Anthropic API base URL. **Only used when provider is `anthropic`.**"
      },
      "OpenCob.anthropic.apiKey": {
        type: "string",
        default: "",
        markdownDescription: "Your Anthropic API key. Get one at [console.anthropic.com](https://console.anthropic.com/)."
      }
    }
  },
  {
    title: "Google Gemini",
    order: 8,
    properties: {
      "OpenCob.gemini.baseUrl": {
        type: "string",
        default: "https://generativelanguage.googleapis.com/v1beta/openai",
        markdownDescription: "Gemini OpenAI-compatible endpoint. **Only used when provider is `gemini`.**"
      },
      "OpenCob.gemini.apiKey": {
        type: "string",
        default: "",
        markdownDescription: "Your Google AI API key. Get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)."
      }
    }
  },
  {
    title: "Custom OpenAI-Compatible",
    order: 9,
    properties: {
      "OpenCob.openaiCompatible.baseUrl": {
        type: "string",
        default: "http://127.0.0.1:8000",
        markdownDescription: "Base URL for any OpenAI-compatible server (vLLM, text-generation-webui, LocalAI, etc.). **Only used when provider is `openai-compatible`.**"
      },
      "OpenCob.openaiCompatible.apiKey": {
        type: "string",
        default: "",
        markdownDescription: "API key for your custom endpoint (leave empty if not required)."
      }
    }
  },
  {
    title: "Inline Completion",
    order: 10,
    properties: {
      "OpenCob.inlineCompletion.enabled": {
        type: "boolean",
        default: true,
        order: 1,
        markdownDescription: "Enable **inline code completion** (ghost text suggestions as you type)."
      },
      "OpenCob.inlineCompletion.debounceMs": {
        type: "number",
        default: 300,
        minimum: 50,
        maximum: 2000,
        order: 2,
        markdownDescription: "Delay (ms) after you stop typing before requesting a completion. Lower = faster but more API calls."
      },
      "OpenCob.inlineCompletion.maxPrefixChars": {
        type: "number",
        default: 8192,
        minimum: 1024,
        maximum: 32768,
        order: 3,
        markdownDescription: "Max characters of code **before** the cursor sent to the completion model (~4 chars \u2248 1 token)."
      },
      "OpenCob.inlineCompletion.maxSuffixChars": {
        type: "number",
        default: 4096,
        minimum: 512,
        maximum: 16384,
        order: 4,
        markdownDescription: "Max characters of code **after** the cursor sent to the completion model."
      },
      "OpenCob.inlineCompletion.maxCrossFileChars": {
        type: "number",
        default: 2048,
        minimum: 0,
        maximum: 8192,
        order: 5,
        markdownDescription: "Max characters from other open files included as cross-file context for better completions."
      }
    }
  },
  {
    title: "Agent & Chat",
    order: 11,
    properties: {
      "OpenCob.contextWindow.maxTokens": {
        type: "number",
        default: 8192,
        minimum: 1024,
        maximum: 131072,
        order: 1,
        markdownDescription: "Max context window size (tokens) for chat interactions. Increase for larger codebases; decrease to save costs."
      },
      "OpenCob.autoApprove.read": {
        type: "boolean",
        default: false,
        order: 2,
        markdownDescription: "Auto-approve **read** tool calls (file reads, searches) without prompting."
      },
      "OpenCob.autoApprove.edit": {
        type: "boolean",
        default: false,
        order: 3,
        markdownDescription: "Auto-approve **file edit** tool calls without prompting. \u26a0\ufe0f Use with caution."
      },
      "OpenCob.autoApprove.command": {
        type: "boolean",
        default: false,
        order: 4,
        markdownDescription: "Auto-approve **terminal command** execution without prompting. \u26a0\ufe0f Use with caution."
      },
      "OpenCob.autoApprove.mcp": {
        type: "boolean",
        default: false,
        order: 5,
        markdownDescription: "Auto-approve **MCP tool** calls without prompting."
      }
    }
  },
  {
    title: "Enterprise",
    order: 12,
    properties: {
      "OpenCob.enterprise.serverUrl": {
        type: "string",
        default: "",
        markdownDescription: "OpenCob Enterprise server URL for team features (telemetry, shared context, policy).\n\nExample: `https://opencob-ee.company.com`"
      },
      "OpenCob.enterprise.token": {
        type: "string",
        default: "",
        markdownDescription: "Auth token for Enterprise server. Auto-set when using `OpenCob: Connect to Enterprise Server` command."
      }
    }
  }
];

fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Done - package.json rewritten with sectioned configuration');
