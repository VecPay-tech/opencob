import type {
  LlmAdapter,
  ChatMessage,
  ChatOptions,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from './types.js';

export interface AnthropicAdapterOpts {
  apiKey: string;
  chatModel?: string;
  completionModel?: string;
}

export class AnthropicAdapter implements LlmAdapter {
  readonly name = 'anthropic';
  private apiKey: string;
  private chatModel_: string;
  private completionModel_: string;
  private readonly baseUrl = 'https://api.anthropic.com/v1';
  private readonly version = '2023-06-01';

  constructor(opts: AnthropicAdapterOpts) {
    this.apiKey = opts.apiKey;
    this.chatModel_ = opts.chatModel ?? 'claude-sonnet-4-6';
    this.completionModel_ = opts.completionModel ?? 'claude-haiku-4-5';
  }

  getChatModel(): string {
    return this.chatModel_;
  }

  getCompletionModel(): string {
    return this.completionModel_;
  }

  setChatModel(m: string): void {
    this.chatModel_ = m;
  }

  setCompletionModel(m: string): void {
    this.completionModel_ = m;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': this.version,
        },
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': this.version,
        },
      });
      if (!r.ok) return [];
      const data = (await r.json()) as { data: Array<{ id: string }> };
      return data.data.map((m) => m.id);
    } catch {
      return [];
    }
  }

  async *chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<StreamChunk> {
    // Anthropic separates system messages from conversation messages
    const systemMsgs = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const convMsgs = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'tool' ? ('user' as const) : m.role,
        content: m.content,
      }));

    const body = {
      model: this.chatModel_,
      messages: convMsgs,
      system: systemMsgs || undefined,
      max_tokens: opts?.maxTokens ?? 4096,
      temperature: opts?.temperature,
      stream: true,
      tools: opts?.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.version,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      yield {
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    if (!response.ok || !response.body) {
      yield { type: 'error', error: `Anthropic API error: ${response.status}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolName = '';
    let currentToolId = '';
    let currentToolInput = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ev = JSON.parse(dataLine.slice(6)) as any;
          if (ev.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta') yield { type: 'text', text: ev.delta.text };
            if (ev.delta?.type === 'input_json_delta')
              currentToolInput += ev.delta.partial_json ?? '';
          } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            currentToolName = ev.content_block.name;
            currentToolId = ev.content_block.id;
            currentToolInput = '';
          } else if (ev.type === 'content_block_stop' && currentToolName) {
            try {
              yield {
                type: 'tool_call',
                toolCallId: currentToolId,
                toolCall: {
                  name: currentToolName,
                  parameters: JSON.parse(currentToolInput || '{}'),
                },
              };
            } catch {
              /* skip */
            }
            currentToolName = '';
          } else if (ev.type === 'message_stop') {
            yield { type: 'done' };
            return;
          }
        } catch {
          /* skip malformed */
        }
      }
    }
    yield { type: 'done' };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    // Anthropic doesn't have a completion endpoint; use chat with a single user message
    const msgs = [
      {
        role: 'user' as const,
        content: req.prompt + (req.suffix ? '\n' + req.suffix : ''),
      },
    ];
    let text = '';
    for await (const chunk of this.chat(msgs, { maxTokens: req.maxTokens })) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
    }
    return { text, finishReason: 'stop' };
  }
}
