import type {
  LlmAdapter,
  ChatMessage,
  ChatOptions,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from './types.js';

export interface GeminiAdapterOpts {
  apiKey: string;
  chatModel?: string;
  completionModel?: string;
}

export class GeminiAdapter implements LlmAdapter {
  readonly name = 'gemini';
  private apiKey: string;
  private chatModel_: string;
  private completionModel_: string;
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(opts: GeminiAdapterOpts) {
    this.apiKey = opts.apiKey;
    this.chatModel_ = opts.chatModel ?? 'gemini-2.0-flash';
    this.completionModel_ = opts.completionModel ?? 'gemini-2.0-flash';
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
      const r = await fetch(`${this.baseUrl}/models?key=${this.apiKey}`);
      return r.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const r = await fetch(`${this.baseUrl}/models?key=${this.apiKey}`);
      if (!r.ok) return [];
      const data = (await r.json()) as { models: Array<{ name: string }> };
      return data.models.map((m) => m.name.replace('models/', ''));
    } catch {
      return [];
    }
  }

  async *chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<StreamChunk> {
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    const systemContent = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const systemInstruction = systemContent ? { parts: [{ text: systemContent }] } : undefined;

    const body = {
      contents,
      systemInstruction,
      generationConfig: { maxOutputTokens: opts?.maxTokens, temperature: opts?.temperature },
    };

    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/models/${this.chatModel_}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!response.ok || !response.body) {
      yield { type: 'error', error: `Gemini API error: ${response.status}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        const data = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
        try {
          const chunk = JSON.parse(data);
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.text) yield { type: 'text', text: part.text };
            if (part.functionCall)
              yield {
                type: 'tool_call',
                toolCall: {
                  name: part.functionCall.name,
                  parameters: part.functionCall.args ?? {},
                },
              };
          }
        } catch {
          /* skip */
        }
      }
    }
    yield { type: 'done' };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    let text = '';
    for await (const chunk of this.chat([{ role: 'user', content: req.prompt }], {
      maxTokens: req.maxTokens,
    })) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
    }
    return { text, finishReason: 'stop' };
  }
}
