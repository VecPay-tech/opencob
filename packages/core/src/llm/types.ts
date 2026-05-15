export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
  /** OpenAI-format tool_calls on assistant messages that initiated a tool call */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'done' | 'error';
  text?: string;
  toolCall?: {
    name: string;
    parameters: Record<string, unknown>;
  };
  toolCallId?: string;
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

  chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk>;

  complete(request: CompletionRequest): Promise<CompletionResponse>;

  listModels(): Promise<string[]>;

  isAvailable(): Promise<boolean>;

  setChatModel(model: string): void;

  setCompletionModel(model: string): void;

  getChatModel(): string;

  getCompletionModel(): string;
}
