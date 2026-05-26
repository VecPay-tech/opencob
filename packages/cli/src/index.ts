import {
  ModeEngine,
  OllamaAdapter,
  ToolRegistry,
  ConversationManager,
  AgentLoop,
  RedactionEngine,
  SnapshotManager,
  RAGPipeline,
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
} from '@opencob/core';
import * as readline from 'node:readline';
import * as path from 'node:path';

const BANNER = `
╔══════════════════════════════════════╗
║        OpenCob Shell v0.1.0         ║
║   Open-Source AI Coding Assistant   ║
╚══════════════════════════════════════╝
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const workspaceRoot = process.cwd();

  // Initialize core components
  const modeEngine = new ModeEngine();
  const ollama = new OllamaAdapter();
  const conversationManager = new ConversationManager({
    persistencePath: path.join(workspaceRoot, '.opencob', 'conversations.json'),
  });
  const snapshotManager = new SnapshotManager(workspaceRoot);

  const toolRegistry = new ToolRegistry(modeEngine, {
    autoApprove: { read: true },
    approvalCallback: async (tool, params) => {
      return new Promise((resolve) => {
        const paramStr = JSON.stringify(params, null, 2);
        console.log(`\n🔧 Tool: ${tool.name}`);
        console.log(`   Parameters: ${paramStr}`);
        const approvalRl = readline.createInterface({
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

  // Initialize RAG
  const ragPipeline = new RAGPipeline();

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
  ]);

  const redactionEngine = new RedactionEngine();
  const agentLoop = new AgentLoop(
    ollama,
    toolRegistry,
    conversationManager,
    modeEngine,
    { workspaceRoot },
    redactionEngine,
    snapshotManager,
  );
  await agentLoop.loadCustomCommands();

  // Non-interactive mode
  if (args.includes('--task')) {
    const taskIndex = args.indexOf('--task');
    const task = args[taskIndex + 1];
    if (!task) {
      console.error('Error: --task requires a value');
      process.exit(1);
    }

    const available = await ollama.isAvailable();
    if (!available) {
      console.error('Error: Ollama is not running. Start it with: ollama serve');
      process.exit(1);
    }

    for await (const event of agentLoop.processMessage(task)) {
      switch (event.type) {
        case 'text':
          process.stdout.write(event.text ?? '');
          break;
        case 'tool_call':
          console.log(
            `\n🔧 ${event.toolCall?.name}(${JSON.stringify(event.toolCall?.parameters)})`,
          );
          break;
        case 'tool_result':
          console.log(`${event.toolResult?.success ? '✅' : '❌'} ${event.toolResult?.content}`);
          break;
        case 'error':
          console.error(`\n⚠️  ${event.error}`);
          break;
        case 'self_correction':
          console.log(`\n🔄 ${event.text}`);
          break;
        case 'compaction':
          console.log(`\n📦 ${event.text}`);
          break;
        case 'done':
          console.log('');
          break;
      }
    }
    process.exit(0);
  }

  // Interactive REPL
  console.log(BANNER);

  const available = await ollama.isAvailable();
  if (!available) {
    console.log('⚠️  Ollama is not running. Start it with: ollama serve');
    console.log('   Continuing in echo mode...\n');
  } else {
    const models = await ollama.listModels();
    console.log(`✅ Ollama connected — ${models.length} models available`);
  }

  console.log(`Mode: ${modeEngine.getActive().name}`);
  console.log('Type /help for commands, Ctrl+C to exit\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'OpenCob> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Slash commands handled by agent loop
    if (input === '/quit') {
      rl.close();
      process.exit(0);
    }

    // Process through the agent loop
    for await (const event of agentLoop.processMessage(input)) {
      switch (event.type) {
        case 'text':
          process.stdout.write(event.text ?? '');
          break;
        case 'tool_call':
          console.log(
            `\n🔧 ${event.toolCall?.name}(${JSON.stringify(event.toolCall?.parameters)})`,
          );
          break;
        case 'tool_result':
          console.log(`${event.toolResult?.success ? '✅' : '❌'} ${event.toolResult?.content}`);
          break;
        case 'mode_switch':
          console.log(`\n${event.text}`);
          break;
        case 'error':
          console.error(`\n⚠️  ${event.error}`);
          break;
        case 'self_correction':
          console.log(`\n🔄 ${event.text}`);
          break;
        case 'compaction':
          console.log(`\n📦 ${event.text}`);
          break;
        case 'done':
          if (event.text) console.log(`\n${event.text}`);
          console.log('');
          break;
      }
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nGoodbye!');
    process.exit(0);
  });
}

main().catch(console.error);
