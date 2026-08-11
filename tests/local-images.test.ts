import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mimeFromPath, normalizeBodyImages, resolveLocalImageUrl } from '../src/server/local-images.js';

// 1x1 red pixel PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_B64, 'base64');

let dir: string;
let pngPath: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mh-local-images-'));
  pngPath = path.join(dir, 'screenshot.png');
  writeFileSync(pngPath, PNG_BYTES);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** file:// URI for an absolute path (works on win + posix). */
function fileUri(p: string): string {
  const slash = p.replace(/\\/g, '/');
  return slash.startsWith('/') ? `file://${slash}` : `file:///${slash}`;
}

/** vscode-resource://file/<path> — the form VS Code clients send. */
function vsResourceUri(p: string): string {
  const slash = p.replace(/\\/g, '/');
  return `vscode-resource://file${slash.startsWith('/') ? '' : '/'}${slash}`;
}

describe('mimeFromPath', () => {
  it('maps common extensions', () => {
    expect(mimeFromPath('/x/a.png')).toBe('image/png');
    expect(mimeFromPath('/x/a.JPG')).toBe('image/jpeg');
    expect(mimeFromPath('/x/a.webp')).toBe('image/webp');
    expect(mimeFromPath('/x/noext')).toBe('application/octet-stream');
  });
});

describe('resolveLocalImageUrl', () => {
  it('inlines a file:// URI as a base64 data URI', async () => {
    const out = await resolveLocalImageUrl(fileUri(pngPath));
    expect(out).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('inlines a vscode-resource://file/ URI', async () => {
    const out = await resolveLocalImageUrl(vsResourceUri(pngPath));
    expect(out).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('leaves http(s) URLs untouched', async () => {
    const url = 'https://example.com/img.png';
    expect(await resolveLocalImageUrl(url)).toBe(url);
  });

  it('leaves data URIs untouched', async () => {
    const uri = `data:image/png;base64,${PNG_B64}`;
    expect(await resolveLocalImageUrl(uri)).toBe(uri);
  });

  it('returns undefined for a missing local file', async () => {
    expect(await resolveLocalImageUrl(fileUri(path.join(dir, 'nope.png')))).toBeUndefined();
  });

  it('returns undefined for empty / exotic schemes', async () => {
    expect(await resolveLocalImageUrl('')).toBeUndefined();
    expect(await resolveLocalImageUrl(undefined)).toBeUndefined();
    expect(await resolveLocalImageUrl('ftp://host/x.png')).toBeUndefined();
  });
});

describe('normalizeBodyImages', () => {
  it('inlines OpenAI image_url.url (chat-completions shape)', async () => {
    const body = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see this?' },
            { type: 'image_url', image_url: { url: fileUri(pngPath) } },
          ],
        },
      ],
    };
    await normalizeBodyImages(body);
    const part = (body.messages![0]!.content as Array<Record<string, unknown>>)[1]!;
    expect((part.image_url as { url: string }).url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('inlines responses input_image.url', async () => {
    const body = {
      model: 'm',
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: { url: vsResourceUri(pngPath) } }] }],
    };
    await normalizeBodyImages(body);
    const part = (body.input as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    expect((part[0]!.image_url as { url: string }).url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('converts Anthropic source url → base64 block', async () => {
    const body = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: fileUri(pngPath) } }],
        },
      ],
    };
    await normalizeBodyImages(body);
    const src = (body.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    expect(src[0]!.source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG_B64 });
  });

  it('converts Gemini fileData.fileUri → inlineData', async () => {
    const body = {
      model: 'm',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'look' }, { fileData: { fileUri: vsResourceUri(pngPath) } }],
        },
      ],
    };
    await normalizeBodyImages(body);
    const parts = (body.contents as Array<Record<string, unknown>>)[0]!.parts as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: PNG_B64 } });
  });

  it('leaves remote URLs and non-image bodies untouched', async () => {
    const body = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
        { role: 'assistant', content: 'ok' },
      ],
    };
    const snapshot = JSON.stringify(body);
    await normalizeBodyImages(body);
    expect(JSON.stringify(body)).toBe(snapshot);
  });
});
