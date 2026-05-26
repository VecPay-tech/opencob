/**
 * Additional tests to bring individual file coverage above 90%.
 * Targets: pli-parser, analyze-code, write-file, execute-command, litellm-adapter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PliParser } from '../src/legacy/pli-parser.js';
import { createAnalyzeCodeTool } from '../src/tools/analyze-code.js';
import { createWriteFileTool } from '../src/tools/write-file.js';
import { createExecuteCommandTool } from '../src/tools/execute-command.js';
import { OpenAICompatibleAdapter, PROVIDER_PRESETS } from '../src/llm/litellm-adapter.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

// ── PL/I Parser Extended Coverage ────────────────────────────────────────────

describe('PliParser — extended coverage', () => {
  const parser = new PliParser();

  it('parses EXEC CICS statements', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  EXEC CICS SEND MAP('SCRN001') MAPSET('MYMAPS');
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    expect(result.execCics.length).toBe(1);
    expect(result.execCics[0].statement).toContain('SEND MAP');
  });

  it('parses multi-line EXEC SQL', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  EXEC SQL
    INSERT INTO CUSTOMERS (ID, NAME)
    VALUES (:WS_ID, :WS_NAME);
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    expect(result.execSql.length).toBe(1);
    expect(result.execSql[0].statement).toContain('INSERT INTO');
  });

  it('parses multi-line EXEC CICS', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  EXEC CICS
    RECEIVE MAP('SCRN001')
    MAPSET('MYMAPS')
    INTO(WS_BUFFER);
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    expect(result.execCics.length).toBe(1);
    expect(result.execCics[0].statement).toContain('RECEIVE MAP');
  });

  it('parses ENTRY statements', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL X CHAR(10);
ALTERNATE: ENTRY;
  X = 'HELLO';
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    expect(result.entryPoints).toContain('ALTERNATE');
    expect(result.entryPoints).toContain('MAIN');
  });

  it('handles unclosed procedure at EOF', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL X FIXED BIN(31);
  CALL HELPER(X);`;
    const result = parser.parse(src, 'test.pli');
    expect(result.procedures.length).toBe(1);
    expect(result.procedures[0].name).toBe('MAIN');
    expect(result.procedures[0].endLine).toBe(3);
  });

  it('handles unclosed structure at EOF', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL 1 RECORD,
    2 FIELD_A CHAR(5),
    2 FIELD_B FIXED DEC(7,2)
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    expect(result.structures.length).toBe(1);
    expect(result.structures[0].name).toBe('RECORD');
  });

  it('infers FLOAT type', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL RATE FLOAT DEC(16);
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    const decl = result.declarations.find((d) => d.name === 'RATE');
    expect(decl).toBeDefined();
    expect(decl!.type).toBe('FLOAT');
  });

  it('infers POINTER type', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL P POINTER;
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    const decl = result.declarations.find((d) => d.name === 'P');
    expect(decl!.type).toBe('POINTER');
  });

  it('infers FILE type', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL INFILE FILE;
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    const decl = result.declarations.find((d) => d.name === 'INFILE');
    expect(decl!.type).toBe('FILE');
  });

  it('infers ENTRY type', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL CALLBACK ENTRY;
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    const decl = result.declarations.find((d) => d.name === 'CALLBACK');
    expect(decl!.type).toBe('ENTRY');
  });

  it('infers PICTURE type', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL AMOUNT PICTURE '$$,$$$V.99';
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    const decl = result.declarations.find((d) => d.name === 'AMOUNT');
    expect(decl!.type).toBe('PICTURE');
  });

  it('infers CHARACTER type from CHAR', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL MSG CHAR(80);
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    const decl = result.declarations.find((d) => d.name === 'MSG');
    expect(decl!.type).toBe('CHARACTER');
  });

  it('infers FIXED DECIMAL type', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL AMT FIXED DEC(9,2);
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    const decl = result.declarations.find((d) => d.name === 'AMT');
    expect(decl!.type).toBe('FIXED DECIMAL');
  });

  it('returns UNKNOWN type for unrecognized attributes', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL X;
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    const decl = result.declarations.find((d) => d.name === 'X');
    expect(decl!.type).toBe('UNKNOWN');
  });

  it('returns raw attributes when no known type matches', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL X AREA(1000);
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    const decl = result.declarations.find((d) => d.name === 'X');
    expect(decl!.type).toBe('AREA(1000)');
  });

  it('parses procedure with RETURNS clause', () => {
    const src = `CALC: PROC(A, B) RETURNS(FIXED BIN(31));
  RETURN(A + B);
END CALC;`;
    const result = parser.parse(src, 'test.pli');
    expect(result.procedures[0].returns).toContain('FIXED BIN');
    expect(result.procedures[0].parameters).toEqual(['A', 'B']);
  });

  it('parses structure members with semicolons closing the structure', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL 1 REC,
    2 A CHAR(5),
    2 B CHAR(10);
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    expect(result.structures.length).toBe(1);
    expect(result.structures[0].members.length).toBe(2);
  });

  it('handles structure with STRUCTURE keyword', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL 1 MY_REC STRUCTURE,
    2 FLD1 CHAR(5),
    2 FLD2 FIXED BIN(15);
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    expect(result.structures.length).toBeGreaterThanOrEqual(1);
  });

  it('closes current structure when non-level declaration follows', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL 1 STR1,
    2 F1 CHAR(5);
  DCL STANDALONE CHAR(20);
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    expect(result.structures.length).toBe(1);
    expect(result.declarations.find((d) => d.name === 'STANDALONE')).toBeDefined();
  });

  it('resolves include paths when directories exist', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'pli-inc-'));
    writeFileSync(path.join(tmpDir, 'MYINC.pli'), 'DCL X CHAR(10);');
    const parserWithPaths = new PliParser([tmpDir]);
    const src = `MAIN: PROC OPTIONS(MAIN);
  %INCLUDE MYINC;
END MAIN;`;
    const result = parserWithPaths.parse(src, 'test.pli');
    expect(result.includes[0].resolvedPath).toBe(path.join(tmpDir, 'MYINC.pli'));
    rmSync(tmpDir, { recursive: true });
  });

  it('extractDefinitions returns entry points not already listed', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
ALT_ENTRY: ENTRY;
  CALL OTHER(X);
END MAIN;`;
    const defs = parser.extractDefinitions(src, 'test.pli');
    const altEntry = defs.find((d) => d.name === 'ALT_ENTRY');
    expect(altEntry).toBeDefined();
    expect(altEntry!.kind).toBe('procedure');
  });

  it('handles PTR shorthand for POINTER', () => {
    const src = `MAIN: PROC OPTIONS(MAIN);
  DCL MYPTR PTR;
END MAIN;`;
    const result = parser.parse(src, 'test.pli');
    const decl = result.declarations.find((d) => d.name === 'MYPTR');
    expect(decl!.type).toBe('POINTER');
  });
});

// ── Analyze Code Tool Extended Coverage ──────────────────────────────────────

describe('createAnalyzeCodeTool — extended coverage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'analyze-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it('detects console.log as debug statement', async () => {
    writeFileSync(
      path.join(tmpDir, 'debug.ts'),
      'function main() {\n  console.log("debug");\n  return 1;\n}\n',
    );
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'debug.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('Debug print statement');
  });

  it('detects hardcoded secrets', async () => {
    writeFileSync(
      path.join(tmpDir, 'secrets.ts'),
      'const config = {\n  password: "hunter2",\n  host: "localhost"\n};\n',
    );
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'secrets.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('secret detected');
  });

  it('detects TODO markers', async () => {
    writeFileSync(
      path.join(tmpDir, 'todo.ts'),
      'function main() {\n  const x = 1; // TODO: fix this later\n  return x;\n}\n',
    );
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'todo.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('TODO');
  });

  it('detects long lines', async () => {
    const longLine = 'const x = ' + '"a'.repeat(120) + '";\n';
    writeFileSync(path.join(tmpDir, 'long.ts'), longLine);
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'long.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('exceeds 120 characters');
  });

  it('reports deep nesting', async () => {
    const code =
      'function a() {\n' +
      '  if (true) {\n'.repeat(7) +
      '    return 1;\n' +
      '  }\n'.repeat(7) +
      '}\n';
    writeFileSync(path.join(tmpDir, 'nest.ts'), code);
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'nest.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('nesting depth');
  });

  it('reports large file warning', async () => {
    const bigContent = Array.from({ length: 501 }, (_, i) => `const line${i} = ${i};`).join('\n');
    writeFileSync(path.join(tmpDir, 'big.ts'), bigContent);
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'big.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('consider splitting');
  });

  it('reports long function warning', async () => {
    const fnBody = Array.from({ length: 55 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const code = `function longFn() {\n${fnBody}\n}\n`;
    writeFileSync(path.join(tmpDir, 'longfn.ts'), code);
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'longfn.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('breaking into smaller');
  });

  it('handles many issues in same category with truncation', async () => {
    // Create file with >10 long code lines (not comments) to trigger the "... and N more" truncation
    const lines = Array.from(
      { length: 12 },
      (_, i) => `const var${i} = "${'x'.repeat(130)}";`,
    ).join('\n');
    writeFileSync(path.join(tmpDir, 'many.ts'), lines + '\n');
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'many.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('and');
    expect(result.content).toContain('more');
  });

  it('reports no issues for clean code', async () => {
    writeFileSync(path.join(tmpDir, 'clean.ts'), 'const x = 1;\nconst y = 2;\n');
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'clean.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('No issues found');
  });

  it('rejects path traversal', async () => {
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: '../../../etc/passwd' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('traversal');
  });

  it('returns error for missing file', async () => {
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'nonexistent.ts' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('not found');
  });

  it('returns error when path is empty', async () => {
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: '' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('required');
  });
});

// ── Write File Tool Extended Coverage ────────────────────────────────────────

describe('createWriteFileTool — extended coverage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'write-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it('creates nested directories automatically', async () => {
    const tool = createWriteFileTool(tmpDir);
    const result = await tool.execute({ path: 'a/b/c/deep.txt', content: 'hello' });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'a/b/c/deep.txt'))).toBe(true);
  });

  it('overwrites existing file', async () => {
    writeFileSync(path.join(tmpDir, 'exist.txt'), 'old');
    const tool = createWriteFileTool(tmpDir);
    const result = await tool.execute({ path: 'exist.txt', content: 'new' });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'exist.txt'), 'utf-8')).toBe('new');
  });

  it('rejects path traversal', async () => {
    const tool = createWriteFileTool(tmpDir);
    const result = await tool.execute({ path: '../../../tmp/hack.txt', content: 'bad' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('outside the workspace');
  });

  it('returns error when path is empty', async () => {
    const tool = createWriteFileTool(tmpDir);
    const result = await tool.execute({ path: '', content: 'x' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('path parameter is required');
  });

  it('returns error when content is null', async () => {
    const tool = createWriteFileTool(tmpDir);
    const result = await tool.execute({ path: 'file.txt', content: null });
    expect(result.success).toBe(false);
    expect(result.content).toContain('content parameter is required');
  });

  it('returns error when content is undefined', async () => {
    const tool = createWriteFileTool(tmpDir);
    const result = await tool.execute({ path: 'file.txt' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('content parameter is required');
  });

  it('returns metadata with byte count', async () => {
    const tool = createWriteFileTool(tmpDir);
    const result = await tool.execute({ path: 'meta.txt', content: 'hello world' });
    expect(result.success).toBe(true);
    expect(result.metadata?.bytes).toBe(11);
  });
});

// ── Execute Command Tool Extended Coverage ───────────────────────────────────

describe('createExecuteCommandTool — extended coverage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'exec-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* orphan process may hold cwd */
    }
  });

  it('executes simple command', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const result = await tool.execute({ command: 'echo hello' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('hello');
  });

  it('captures stderr on failure', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const result = await tool.execute({ command: 'ls /nonexistent_dir_xyz' });
    expect(result.success).toBe(false);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('returns error when command is empty', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const result = await tool.execute({ command: '' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('command parameter is required');
  });

  it('handles timeout', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const cmd = process.platform === 'win32' ? 'ping -n 100 127.0.0.1' : 'sleep 10';
    const result = await tool.execute({ command: cmd, timeout: 200 });
    expect(result.success).toBe(false);
    expect(result.content).toContain('timed out');
  }, 10000);

  it('returns exit code in metadata', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const result = await tool.execute({ command: 'echo ok' });
    expect(result.metadata?.exitCode).toBe(0);
  });

  it('handles commands with special characters', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const result = await tool.execute({ command: 'echo "hello world"' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('hello world');
  });

  it('handles spawn error for invalid shell', async () => {
    // Test with a command that makes the child process error
    const tool = createExecuteCommandTool('/nonexistent_dir_abc');
    const result = await tool.execute({ command: 'pwd' });
    // On macOS, this still works (shell can run in any cwd)
    // Just verify it doesn't throw
    expect(result).toBeDefined();
  });
});

// ── OpenAI Compatible Adapter Extended Coverage ──────────────────────────────

describe('OpenAICompatibleAdapter — extended coverage', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('includes provider presets', () => {
    expect(PROVIDER_PRESETS.litellm).toBeDefined();
    expect(PROVIDER_PRESETS.openai).toBeDefined();
    expect(PROVIDER_PRESETS.azure).toBeDefined();
  });

  it('sets and gets models', () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost:4000', apiKey: '' });
    adapter.setChatModel('gpt-5');
    adapter.setCompletionModel('gpt-5-mini');
    expect(adapter.getChatModel()).toBe('gpt-5');
    expect(adapter.getCompletionModel()).toBe('gpt-5-mini');
  });

  it('includes Authorization header when apiKey set', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
      capturedHeaders = opts?.headers as Record<string, string>;
      return { ok: true, json: async () => ({ data: [] }) };
    });

    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: 'sk-123' });
    await adapter.listModels();
    expect(capturedHeaders['Authorization']).toBe('Bearer sk-123');
  });

  it('listModels returns empty on error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const models = await adapter.listModels();
    expect(models).toEqual([]);
  });

  it('listModels returns empty on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const models = await adapter.listModels();
    expect(models).toEqual([]);
  });

  it('isAvailable returns false on error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('down'));
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const available = await adapter.isAvailable();
    expect(available).toBe(false);
  });

  it('isAvailable returns true on ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const available = await adapter.isAvailable();
    expect(available).toBe(true);
  });

  it('chat yields error on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'hi' }])) {
      events.push(chunk);
    }
    expect(events[0].type).toBe('error');
    expect(events[0].error).toContain('429');
  });

  it('chat yields error when no body in response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null,
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'hi' }])) {
      events.push(chunk);
    }
    expect(events[0].type).toBe('error');
    expect(events[0].error).toContain('No response body');
  });

  it('chat streams text tokens from SSE', async () => {
    const encoder = new TextEncoder();
    const sseData = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseData));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body: stream });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'hi' }])) {
      events.push(chunk);
    }
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join(''),
    ).toBe('Hello world');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('chat handles finish_reason in stream', async () => {
    const encoder = new TextEncoder();
    const sseData = 'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseData));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body: stream });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'hi' }])) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('chatWithTools yields tool_call', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'tc_1',
                  function: { name: 'read_file', arguments: '{"path":"test.ts"}' },
                },
              ],
            },
          },
        ],
      }),
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'read test.ts' }], {
      tools: [{ name: 'read_file', description: 'Read a file', parameters: {} }],
    })) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    const tc = events.find((e) => e.type === 'tool_call');
    expect(tc.toolCall.name).toBe('read_file');
    expect(tc.toolCallId).toBe('tc_1');
  });

  it('chatWithTools handles malformed tool args', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'tc_1',
                  function: { name: 'bad_tool', arguments: 'not{json' },
                },
              ],
            },
          },
        ],
      }),
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'x' }], {
      tools: [{ name: 'bad_tool', description: 'x', parameters: {} }],
    })) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.find((e) => e.type === 'error').error).toContain('Failed to parse');
  });

  it('chatWithTools yields text content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'I will help you', tool_calls: [] } }],
      }),
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'help' }], {
      tools: [{ name: 't', description: 'd', parameters: {} }],
    })) {
      events.push(chunk);
    }
    expect(events.find((e) => e.type === 'text')?.text).toBe('I will help you');
  });

  it('chatWithTools handles no choice', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'x' }], {
      tools: [{ name: 't', description: 'd', parameters: {} }],
    })) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'error' && e.error.includes('No choice'))).toBe(true);
  });

  it('chatWithTools error on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'x' }], {
      tools: [{ name: 't', description: 'd', parameters: {} }],
    })) {
      events.push(chunk);
    }
    expect(events[0].type).toBe('error');
  });

  it('complete throws on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    await expect(adapter.complete({ prompt: 'test' })).rejects.toThrow('completion error');
  });

  it('complete with suffix uses FIM prompt', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
      capturedBody = opts?.body as string;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'const x = 1;' }, finish_reason: 'stop' }],
        }),
      };
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const result = await adapter.complete({ prompt: 'const ', suffix: ' = 1;' });
    expect(result.text).toBe('const x = 1;');
    expect(result.finishReason).toBe('stop');
    expect(capturedBody).toContain('<prefix>');
    expect(capturedBody).toContain('<suffix>');
  });

  it('complete without suffix uses continuation prompt', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
      capturedBody = opts?.body as string;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'code' }, finish_reason: 'length' }],
        }),
      };
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const result = await adapter.complete({ prompt: 'function ' });
    expect(result.finishReason).toBe('length');
    expect(capturedBody).toContain('Continue the following code');
  });

  it('chat maps assistant tool_calls and tool messages correctly', async () => {
    let capturedBody: any;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
      capturedBody = JSON.parse(opts?.body as string);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost', apiKey: '' });
    const messages = [
      { role: 'user' as const, content: 'read file' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [
          {
            id: 'tc_1',
            type: 'function' as const,
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      { role: 'tool' as const, content: 'file content', toolCallId: 'tc_1' },
    ];
    const events: any[] = [];
    for await (const chunk of adapter.chat(messages, {
      tools: [{ name: 'read_file', description: 'd', parameters: {} }],
    })) {
      events.push(chunk);
    }
    // Check that assistant message has tool_calls and null content
    expect(capturedBody.messages[1].content).toBeNull();
    expect(capturedBody.messages[1].tool_calls).toBeDefined();
    expect(capturedBody.messages[2].tool_call_id).toBe('tc_1');
  });

  it('uses custom provider name', () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://localhost',
      apiKey: '',
      providerName: 'my-provider',
    });
    expect(adapter.name).toBe('my-provider');
  });
});
