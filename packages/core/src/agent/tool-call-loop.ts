import type { LlmAdapter } from '../llm/types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ConversationManager } from '../conversation/conversation-manager.js';
import type { RedactionEngine } from '../security/redaction-engine.js';
import type { SnapshotManager } from '../checkpoints/snapshot-manager.js';
import type { CustomizationLoader } from './customization-loader.js';
import type { HookContext } from './hooks-engine.js';
import type { PostEditVerifier } from './post-edit-verifier.js';
import type { AgentEvent } from './agent-types.js';
import { ChangeTracker } from './change-tracker.js';

export interface ToolCallLoopOpts {
  llm: LlmAdapter;
  toolRegistry: ToolRegistry;
  conversationManager: ConversationManager;
  redactionEngine: RedactionEngine;
  changeTracker: ChangeTracker;
  maxToolRounds: number;
  maxSelfCorrectionAttempts: number;
  enablePostEditVerification: boolean;
  postEditVerifier: PostEditVerifier | null;
  workspaceRoot?: string;
  snapshotManager?: SnapshotManager | null;
  customizationLoader?: CustomizationLoader | null;
}

export class ToolCallLoop {
  private opts: ToolCallLoopOpts;

  constructor(opts: ToolCallLoopOpts) {
    this.opts = opts;
  }

  async *run(systemPrompt: string, maxContextTokens: number): AsyncIterable<AgentEvent> {
    const {
      llm,
      toolRegistry,
      conversationManager,
      redactionEngine,
      changeTracker,
      maxToolRounds,
      maxSelfCorrectionAttempts,
      postEditVerifier,
      snapshotManager,
      customizationLoader,
    } = this.opts;

    let rounds = 0;
    let selfCorrectionAttempts = 0;
    const maxCorrections = maxSelfCorrectionAttempts;

    while (rounds < maxToolRounds) {
      rounds++;

      // Build messages for LLM
      const messages = conversationManager.getContextWindow(systemPrompt, maxContextTokens);

      // Redact secrets before sending to LLM
      const redactedMessages = redactionEngine.redactMessages(messages);

      // Get tool definitions for native function calling
      const toolDefs = toolRegistry.getToolDefinitions();

      // Emit reasoning phase before LLM call
      yield { type: 'phase_change', phase: 'reasoning' };
      yield {
        type: 'thinking',
        text: 'Generating response' + (rounds > 1 ? ' (round ' + rounds + ')' : ''),
      };

      // Stream LLM response
      let fullResponse = '';
      let pendingToolCall: { name: string; parameters: Record<string, unknown> } | null = null;
      let pendingToolCallId = '';

      try {
        for await (const chunk of llm.chat(redactedMessages, { tools: toolDefs })) {
          switch (chunk.type) {
            case 'text':
              if (chunk.text) {
                fullResponse += chunk.text;
                yield { type: 'text', text: chunk.text };
              }
              break;

            case 'tool_call':
              if (chunk.toolCall) {
                pendingToolCall = chunk.toolCall;
                pendingToolCallId = chunk.toolCallId ?? `call_${rounds}`;
                yield { type: 'phase_change', phase: 'analysing' };
                yield { type: 'tool_call', toolCall: chunk.toolCall };
              }
              break;

            case 'error':
              yield { type: 'error', error: chunk.error };
              conversationManager.addMessage({
                role: 'assistant',
                content: `Error: ${chunk.error}`,
              });
              return;

            case 'done':
              break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', error: msg };
        return;
      }

      // Fallback: detect JSON text that looks like a tool call (model didn't use function calling)
      if (!pendingToolCall && fullResponse) {
        const parsed = this.tryParseTextToolCall(fullResponse);
        if (parsed) {
          pendingToolCall = parsed;
          pendingToolCallId = `text_call_${rounds}`;
          yield { type: 'phase_change', phase: 'analysing' };
          yield { type: 'tool_call', toolCall: parsed };
          // Clear the text so we don't display the JSON
          fullResponse = '';
        }
      }

      // If no tool call, we're done — save assistant response
      if (!pendingToolCall) {
        if (fullResponse) {
          conversationManager.addMessage({
            role: 'assistant',
            content: fullResponse,
          });
        }
        // Emit changes summary if files were modified during this turn (§8.4.1.1)
        const changeSummary = changeTracker.buildSummaryEvent();
        if (changeSummary) yield changeSummary;
        yield { type: 'done' };
        return;
      }

      // Save the assistant's response (including the tool call intent)
      conversationManager.addMessage({
        role: 'assistant',
        content: fullResponse || '',
        toolCalls: [
          {
            id: pendingToolCallId,
            type: 'function',
            function: {
              name: pendingToolCall.name,
              arguments: JSON.stringify(pendingToolCall.parameters),
            },
          },
        ],
      });

      // Capture file snapshot before modification (for undo support)
      if (snapshotManager && pendingToolCall) {
        const editTools = ['write_to_file', 'apply_diff', 'insert_content', 'multi_edit'];
        if (editTools.includes(pendingToolCall.name)) {
          const filePath = pendingToolCall.parameters.path as string;
          if (filePath) {
            snapshotManager.captureFile(filePath);
          }
        }
      }

      // Execute the tool
      yield { type: 'phase_change', phase: 'processing' };
      yield {
        type: 'thinking',
        text:
          'Executing ' +
          pendingToolCall.name +
          (pendingToolCall.parameters.path ? ': ' + pendingToolCall.parameters.path : ''),
      };

      // Fire onToolCallBefore hook
      if (customizationLoader) {
        const hookCtx: HookContext = {
          event: 'onToolCallBefore',
          toolName: pendingToolCall.name,
          filePath: pendingToolCall.parameters.path as string | undefined,
        };
        customizationLoader.fireHook(hookCtx);
      }

      const result = await toolRegistry.execute({
        toolName: pendingToolCall.name,
        parameters: pendingToolCall.parameters,
      });

      // Fire onToolCallAfter hook
      if (customizationLoader) {
        const hookCtx: HookContext = {
          event: 'onToolCallAfter',
          toolName: pendingToolCall.name,
          filePath: pendingToolCall.parameters.path as string | undefined,
          data: { success: result.success },
        };
        customizationLoader.fireHook(hookCtx);
      }

      yield { type: 'phase_change', phase: 'evaluating' };
      yield {
        type: 'thinking',
        text: result.success ? 'Tool completed successfully' : 'Tool returned an error',
      };
      yield { type: 'tool_result', toolResult: result };

      // Track file changes for changes summary bar (§8.4.1.1)
      if (result.success) {
        const writeTools = ['write_to_file', 'apply_diff', 'insert_content', 'multi_edit'];
        if (writeTools.includes(pendingToolCall.name)) {
          const filePath = pendingToolCall.parameters.path as string | undefined;
          if (filePath) {
            // Use tool output content so summaries reflect actual applied diff/write result
            const fileContent = typeof result.content === 'string' ? result.content : '';
            changeTracker.track(filePath, fileContent, pendingToolCall.name);

            // Fire onFileChange hook
            if (customizationLoader) {
              customizationLoader.fireHook({ event: 'onFileChange', filePath });
            }
          }
        }
      }

      // Post-edit verification (F6.4): auto-check syntax after write tools
      if (postEditVerifier && result.success && this.opts.enablePostEditVerification) {
        const writeTools = ['write_to_file', 'apply_diff', 'insert_content', 'multi_edit'];
        if (writeTools.includes(pendingToolCall.name)) {
          const filePaths: string[] = [];
          const p = pendingToolCall.parameters.path as string | undefined;
          if (p) filePaths.push(p);
          for (const fp of filePaths) {
            const verification = await postEditVerifier.verify(fp);
            if (!verification.valid) {
              const errMsg = `Post-edit verification failed for ${fp}:\n${verification.errors.join('\n')}`;
              yield { type: 'verification', text: errMsg };
              // Add to conversation so LLM can self-correct
              conversationManager.addMessage({
                role: 'system',
                content: `[POST-EDIT WARNING] ${errMsg}\nPlease review and fix these syntax issues.`,
              });
            }
          }
        }
      }

      // Self-correction: if execute_command failed (non-zero exit), try to diagnose and fix
      if (
        !result.success &&
        pendingToolCall.name === 'execute_command' &&
        selfCorrectionAttempts < maxCorrections
      ) {
        selfCorrectionAttempts++;
        yield {
          type: 'self_correction',
          text: `Build/test failed — attempting self-correction (attempt ${selfCorrectionAttempts}/${maxCorrections})`,
          attempt: selfCorrectionAttempts,
        };

        // Add error context so LLM can diagnose
        conversationManager.addMessage({
          role: 'tool',
          content: `[SELF-CORRECTION] The command failed. Here is the error output:\n${result.content}\n\nPlease diagnose the error and fix the issue. This is self-correction attempt ${selfCorrectionAttempts} of ${maxCorrections}.`,
          name: pendingToolCall.name,
          toolCallId: pendingToolCallId,
        });

        continue; // Continue the loop — LLM will see the error and try to fix
      }

      // Add tool result to conversation
      conversationManager.addMessage({
        role: 'tool',
        content: result.content,
        name: pendingToolCall.name,
        toolCallId: pendingToolCallId,
      });

      // Continue the loop — the LLM will see the tool result and either respond or call another tool
    }

    // Max rounds exceeded
    const maxRoundsSummary = changeTracker.buildSummaryEvent();
    if (maxRoundsSummary) yield maxRoundsSummary;
    yield {
      type: 'error',
      error: `Agent reached maximum tool rounds (${maxToolRounds}). Stopping.`,
    };
    yield { type: 'done' };
  }

  /**
   * Try to parse a text response as a JSON tool call.
   * Some models output tool parameters as plain text JSON instead of using function calling.
   * Detects patterns like: {"path":"...", "content":"..."} → write_to_file
   */
  private tryParseTextToolCall(
    text: string,
  ): { name: string; parameters: Record<string, unknown> } | null {
    const trimmed = text.trim();
    // Must look like JSON object
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj !== 'object' || obj === null) return null;

      // Pattern: { path: "...", content: "..." } → write_to_file
      if (typeof obj.path === 'string' && typeof obj.content === 'string' && obj.path.length > 0) {
        return { name: 'write_to_file', parameters: { path: obj.path, content: obj.content } };
      }

      // Pattern: { name: "tool_name", parameters: {...} } → direct tool call
      if (typeof obj.name === 'string' && typeof obj.parameters === 'object') {
        return { name: obj.name, parameters: obj.parameters };
      }

      return null;
    } catch {
      return null;
    }
  }
}
