export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'done' | 'error';
  text?: string;
  toolCall?: {
    name: string;
    parameters: Record<string, unknown>;
  };
  error?: string;
}

export interface CompletionRequest {
  prompt: string;
  suffix?: string;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
}

export interface CompletionResponse {
  text: string;
  finishReason: 'stop' | 'length';
}

export interface LlmAdapter {
  readonly name: string;

  chat(
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): AsyncIterable<StreamChunk>;

  complete(request: CompletionRequest): Promise<CompletionResponse>;

  listModels(): Promise<string[]>;

  isAvailable(): Promise<boolean>;

  setChatModel(model: string): void;

  setCompletionModel(model: string): void;

  getChatModel(): string;

  getCompletionModel(): string;
}
