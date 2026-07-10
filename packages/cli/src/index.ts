import { createInterface } from 'node:readline';
import * as path from 'node:path';

import {
  AgentLoop,
  ModelRouter,
  ModeEngine,
  ToolRegistry,
  ConversationManager,
  RedactionEngine,
  SnapshotManager,
  RAGPipeline,
  MCPClient,
  createReadFileTool,
  createListFilesTool,
  createSearchFilesTool,
  createWriteFileTool,
  createApplyDiffTool,
  createExecuteCommandTool,
  createAskFollowupTool,
  createSwitchModeTool,
  createListCodeDefinitionsTool,
  createInsertContentTool,
  createUndoLastTurnTool,
  createAnalyzeCodeTool,
  createGenerateDiagramTool,
  createSemanticSearchTool,
  createFindReferencesTool,
  createShowImpactChainTool,
  createMultiEditTool,
  createManageTodoTool,
  createUseMcpTool,
} from '@opencob/core';
import { Spinner } from './spinner.js';
import { CliRenderer } from './renderer.js';
import { expandMentions } from './mentions.js';

const BANNER = `
╔══════════════════════════════════════╗
║        OpenCob Shell v0.1.0         ║
║   Open-Source AI Coding Assistant   ║
╚══════════════════════════════════════╝
`;

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();

  // Build LLM adapter from environment
  const router = ModelRouter.fromEnv();
  const llm = router.getAdapterForTask('chat');

  // Initialize core components
  const modeEngine = new ModeEngine();
  const conversationManager = new ConversationManager({
    persistencePath: path.join(workspaceRoot, '.opencob', 'conversations.json'),
  });
  const snapshotManager = new SnapshotManager(workspaceRoot);
  const ragPipeline = new RAGPipeline();

  const toolRegistry = new ToolRegistry(modeEngine, {
    autoApprove: { read: true },
    approvalCallback: async (tool, params) => {
      return new Promise((resolve) => {
        const paramStr = JSON.stringify(params, null, 2);
        console.log(`\n  Tool: ${tool.name}`);
        console.log(`   Parameters: ${paramStr}`);
        const approvalRl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        approvalRl.question('   Approve? (y/n): ', (answer) => {
          approvalRl.close();
          resolve(answer.trim().toLowerCase() === 'y');
        });
      });
    },
  });

  // Initialize MCP client
  const mcpClient = new MCPClient();
  const mcpServers = await mcpClient.loadConfig(workspaceRoot);
  for (const server of mcpServers) {
    try {
      await mcpClient.connect(server);
    } catch {
      // Non-fatal — continue without this MCP server
    }
  }

  toolRegistry.registerAll([
    createReadFileTool(workspaceRoot),
    createListFilesTool(workspaceRoot),
    createSearchFilesTool(workspaceRoot),
    createWriteFileTool(workspaceRoot),
    createApplyDiffTool(workspaceRoot),
    createExecuteCommandTool(workspaceRoot),
    createAskFollowupTool(),
    createSwitchModeTool(modeEngine),
    createListCodeDefinitionsTool(workspaceRoot),
    createInsertContentTool(workspaceRoot),
    createUndoLastTurnTool(snapshotManager),
    createAnalyzeCodeTool(workspaceRoot),
    createGenerateDiagramTool(workspaceRoot),
    createSemanticSearchTool(ragPipeline),
    createFindReferencesTool(workspaceRoot),
    createShowImpactChainTool(workspaceRoot),
    createMultiEditTool(workspaceRoot, snapshotManager),
    createManageTodoTool(),
    createUseMcpTool(mcpClient),
  ]);

  const redactionEngine = new RedactionEngine();
  const agentLoop = new AgentLoop(
    llm,
    toolRegistry,
    conversationManager,
    modeEngine,
    { workspaceRoot },
    redactionEngine,
    snapshotManager,
  );
  await agentLoop.loadCustomCommands();

  const spinner = new Spinner();
  const renderer = new CliRenderer(spinner);
  const cwd = workspaceRoot;

  const isTTY = process.stdin.isTTY === true;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\nYou: ',
    terminal: isTTY,
  });

  if (isTTY) {
    console.log(BANNER);
    console.log(`Mode: ${modeEngine.getActive().name}`);
    console.log('OpenCob CLI — type your question or /help. Ctrl+C to exit.\n');
    rl.prompt();
  }

  rl.on('line', async (rawInput: string) => {
    const input = rawInput.trim();
    if (!input) {
      if (isTTY) rl.prompt();
      return;
    }

    if (input === '/quit') {
      rl.close();
      return;
    }

    const expanded = expandMentions(input, cwd);

    try {
      const events = agentLoop.processMessage(expanded);
      if (isTTY) process.stdout.write('\nAssistant: ');
      await renderer.render(events);
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
    }

    if (isTTY) rl.prompt();
  });

  rl.on('close', () => {
    spinner.stop();
    if (isTTY) console.log('\nGoodbye.');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
