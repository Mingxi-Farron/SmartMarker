import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to test that chatCompletion accepts and uses per-call maxTokens.
// Since ModelClient uses doChatRequest internally, we'll test the actual method
// by spying on the internal request method.

describe('Phase 0 P1: chatCompletion per-call maxTokens', () => {
  let ModelClient;

  beforeEach(async () => {
    ({ ModelClient } = await import('../agents/model-client.js'));
  });

  it('should use this.maxTokens when maxTokens param is not provided', async () => {
    const client = new ModelClient({
      endpoint: 'http://test',
      apiKey: 'test-key',
      model: 'test-model',
      mockMode: false,
      maxTokens: 1200
    });

    // Spy on doChatRequest to capture the payload
    let capturedPayload = null;
    client.doChatRequest = async (payload) => {
      capturedPayload = payload;
      return { ok: true, data: { choices: [{ message: { content: 'test reply' } }] } };
    };

    await client.chatCompletion({
      messages: [{ role: 'user', content: 'hello' }]
    });

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload.max_tokens).toBe(1200);
  });

  it('should use per-call maxTokens when provided', async () => {
    const client = new ModelClient({
      endpoint: 'http://test',
      apiKey: 'test-key',
      model: 'test-model',
      mockMode: false,
      maxTokens: 1200
    });

    let capturedPayload = null;
    client.doChatRequest = async (payload) => {
      capturedPayload = payload;
      return { ok: true, data: { choices: [{ message: { content: 'test reply' } }] } };
    };

    await client.chatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 6000
    });

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload.max_tokens).toBe(6000);
  });

  it('should clamp per-call maxTokens within valid range (128-8192)', async () => {
    const client = new ModelClient({
      endpoint: 'http://test',
      apiKey: 'test-key',
      model: 'test-model',
      mockMode: false,
      maxTokens: 1200
    });

    let capturedPayload = null;
    client.doChatRequest = async (payload) => {
      capturedPayload = payload;
      return { ok: true, data: { choices: [{ message: { content: 'test reply' } }] } };
    };

    // Too small - should clamp to 128
    await client.chatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 10
    });
    expect(capturedPayload.max_tokens).toBe(128);

    // Too large - should clamp to 8192
    await client.chatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 99999
    });
    expect(capturedPayload.max_tokens).toBe(8192);
  });

  it('should fall back to this.maxTokens when per-call maxTokens is invalid', async () => {
    const client = new ModelClient({
      endpoint: 'http://test',
      apiKey: 'test-key',
      model: 'test-model',
      mockMode: false,
      maxTokens: 1200
    });

    let capturedPayload = null;
    client.doChatRequest = async (payload) => {
      capturedPayload = payload;
      return { ok: true, data: { choices: [{ message: { content: 'test reply' } }] } };
    };

    await client.chatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 'not-a-number'
    });
    expect(capturedPayload.max_tokens).toBe(1200);
  });
});
