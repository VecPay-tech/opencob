import type {
  LlmAdapter,
  ChatMessage,
  ChatOptions,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from './types.js';

export interface OpenAiAdapterOpts {
  apiKey: string;
  baseUrl?: string;
  chatModel?: string;
  completionModel?: string;
}

export class OpenAiAdapter implements LlmAdapter {
  readonly name = 'openai';
  private apiKey: string;
  private baseUrl: string;
  private chatModel_: string;
  private completionModel_: string;

  constructor(opts: OpenAiAdapterOpts) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.chatModel_ = opts.chatModel ?? 'gpt-4o';
    this.completionModel_ = opts.completionModel ?? 'gpt-3.5-turbo';
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
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!r.ok) return [];
      const data = (await r.json()) as { data: Array<{ id: string }> };
      return data.data.map((m) => m.id);
    } catch {
      return [];
    }
  }

  async *chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<StreamChunk> {
    const body = {
      model: this.chatModel_,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_call_id: m.toolCallId,
        name: m.name,
      })),
      stream: true,
      temperature: opts?.temperature,
      max_tokens: opts?.maxTokens,
      tools: opts?.tools?.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    };
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
      return;
    }
    if (!response.ok || !response.body) {
      yield { type: 'error', error: `OpenAI API error: ${response.status}` };
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolArgs: Record<string, string> = {};
    const toolNames: Record<string, string> = {};
    const toolIds: Record<string, string> = {};
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) yield { type: 'text', text: delta.content };
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = String(tc.index ?? 0);
              if (tc.id) toolIds[idx] = tc.id;
              if (tc.function?.name) toolNames[idx] = tc.function.name;
              if (tc.function?.arguments)
                toolArgs[idx] = (toolArgs[idx] ?? '') + tc.function.arguments;
            }
          }
        } catch {
          /* skip malformed */
        }
      }
    }
    for (const idx of Object.keys(toolNames)) {
      try {
        yield {
          type: 'tool_call',
          toolCallId: toolIds[idx],
          toolCall: { name: toolNames[idx], parameters: JSON.parse(toolArgs[idx] ?? '{}') },
        };
      } catch {
        /* skip malformed tool args */
      }
    }
    yield { type: 'done' };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = {
      model: this.completionModel_,
      prompt: req.prompt,
      suffix: req.suffix,
      max_tokens: req.maxTokens ?? 256,
      temperature: req.temperature ?? 0,
      stop: req.stop,
    };
    const r = await fetch(`${this.baseUrl}/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      throw new Error(`OpenAI completions API error: ${r.status}`);
    }
    const data = (await r.json()) as { choices: Array<{ text: string; finish_reason: string }> };
    return {
      text: data.choices[0]?.text ?? '',
      finishReason: data.choices[0]?.finish_reason === 'length' ? 'length' : 'stop',
    };
  }
}
