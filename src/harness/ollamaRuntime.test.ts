import { describe, expect, it } from 'vitest';
import {
  OLLAMA_DEFAULT_URL,
  normalizeOllamaBaseUrl,
  ollamaTagsUrl,
  parseOllamaModels,
} from './ollamaRuntime';

describe('normalizeOllamaBaseUrl', () => {
  it('strips trailing slashes and a stray /v1, falls back to default', () => {
    expect(normalizeOllamaBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(normalizeOllamaBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(normalizeOllamaBaseUrl('')).toBe(OLLAMA_DEFAULT_URL);
  });
});

describe('ollamaTagsUrl', () => {
  it('points to /api/tags at the server root', () => {
    expect(ollamaTagsUrl('http://localhost:11434')).toBe('http://localhost:11434/api/tags');
    expect(ollamaTagsUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/api/tags');
    expect(ollamaTagsUrl('http://box:11434/')).toBe('http://box:11434/api/tags');
  });
});

describe('parseOllamaModels', () => {
  it('extracts unique model names from /api/tags', () => {
    const json = { models: [{ name: 'llama3.2:3b' }, { name: 'qwen2.5-coder:7b' }, { name: 'llama3.2:3b' }] };
    expect(parseOllamaModels(json)).toEqual(['llama3.2:3b', 'qwen2.5-coder:7b']);
  });
  it('is defensive against malformed payloads', () => {
    expect(parseOllamaModels(null)).toEqual([]);
    expect(parseOllamaModels({})).toEqual([]);
    expect(parseOllamaModels({ models: 'nope' })).toEqual([]);
    expect(parseOllamaModels({ models: [{}, { name: '' }] })).toEqual([]);
  });
});
