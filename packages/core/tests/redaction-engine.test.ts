import { describe, it, expect } from 'vitest';
import { RedactionEngine } from '../src/security/redaction-engine.js';

describe('RedactionEngine', () => {
  const engine = new RedactionEngine();

  it('redacts AWS access keys', () => {
    const result = engine.redact('key = AKIAIOSFODNN7EXAMPLE');
    expect(result.redacted).toContain('[REDACTED_AWS_KEY]');
    expect(result.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.redactionCount).toBeGreaterThan(0);
  });

  it('redacts JWT tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = engine.redact(`token: ${jwt}`);
    expect(result.redacted).toContain('[REDACTED_JWT]');
    expect(result.redacted).not.toContain('eyJhbGci');
  });

  it('redacts private keys', () => {
    const key =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    const result = engine.redact(key);
    expect(result.redacted).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('redacts GitHub tokens', () => {
    const result = engine.redact('GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(result.redacted).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('redacts password assignments', () => {
    const result = engine.redact('password="super_secret_123"');
    expect(result.redacted).toContain('[REDACTED_PASSWORD]');
    expect(result.redacted).not.toContain('super_secret_123');
  });

  it('redacts connection strings', () => {
    const result = engine.redact('DB_URL=postgres://user:pass@host:5432/db');
    expect(result.redacted).toContain('[REDACTED_CONNECTION_STRING]');
  });

  it('redacts bearer tokens', () => {
    const result = engine.redact('Authorization: Bearer abc123def456');
    expect(result.redacted).toContain('[REDACTED_TOKEN]');
  });

  it('preserves non-sensitive text', () => {
    const safe = 'function add(a, b) { return a + b; }';
    const result = engine.redact(safe);
    expect(result.redacted).toBe(safe);
    expect(result.redactionCount).toBe(0);
  });

  it('handles multiple redactions in one text', () => {
    const text = 'key=AKIAIOSFODNN7EXAMPLE password="mysecret123"';
    const result = engine.redact(text);
    expect(result.redactions.length).toBeGreaterThanOrEqual(2);
  });

  it('supports custom rules', () => {
    const custom = new RedactionEngine([
      { name: 'EMPLOYEE_ID', pattern: /EMP-\d{6}/g, replacement: '[REDACTED_EMPLOYEE]' },
    ]);
    const result = custom.redact('Employee: EMP-123456');
    expect(result.redacted).toContain('[REDACTED_EMPLOYEE]');
  });

  it('redacts messages array', () => {
    const messages = [
      { role: 'user', content: 'My password="secret123"' },
      { role: 'assistant', content: 'I see your credentials' },
    ];
    const redacted = engine.redactMessages(messages);
    expect(redacted[0].content).toContain('[REDACTED_PASSWORD]');
    expect(redacted[1].content).toBe('I see your credentials');
  });

  it('lists rule names', () => {
    const names = engine.listRules();
    expect(names).toContain('AWS_ACCESS_KEY');
    expect(names).toContain('JWT');
    expect(names).toContain('PRIVATE_KEY');
  });
});
