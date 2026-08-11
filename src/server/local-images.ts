import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

type AnyObj = Record<string, unknown>;

const DATA_URI = /^data:([^;,]+);base64,(.+)$/s;

/** Map a `file://` or `vscode-resource://` URI to a local filesystem path. */
function localPathFromUri(uri: string): string | undefined {
  const m = /^(?:file|vscode-resource):\/{1,3}([^?#]+)/i.exec(uri);
  if (!m) return undefined;
  const decoded = decodeURIComponent(m[1] ?? '');
  // Collect candidate paths across the URI forms clients actually send:
  //   file:///C:/…            file://c:/…            file:///tmp/x.png
  //   vscode-resource://file/c:/…   vscode-resource://file//tmp/x.png
  // A non-"file" authority (e.g. remote webview hashes) yields no candidate
  // that exists, so those URLs are left untouched for the upstream.
  const candidates = new Set<string>([decoded]);
  const noAuth = decoded.replace(/^file\/+/i, '');
  if (noAuth !== decoded) {
    candidates.add(noAuth);
    candidates.add(`/${noAuth}`);
  }
  if (/^\/[a-zA-Z]:/.test(noAuth)) candidates.add(noAuth.slice(1));
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
    if (process.platform === 'win32') {
      const win = c.replace(/\//g, '\\');
      if (win !== c && existsSync(win)) return win;
    }
  }
  return undefined;
}

export function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Resolve a client-supplied image URL into something the upstream can use:
 * - data:/http(s): left untouched (returned as-is)
 * - file:// or vscode-resource:// pointing at an existing local file: read it
 *   and return an inline base64 data URI
 * - anything else (unresolvable local, exotic schemes): `undefined` — the
 *   caller keeps the original URL
 */
export async function resolveLocalImageUrl(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  if (/^data:/i.test(url) || /^https?:\/\//i.test(url)) return url;
  const local = localPathFromUri(url);
  if (!local) return undefined;
  try {
    const data = await readFile(local);
    return `data:${mimeFromPath(local)};base64,${data.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/**
 * Deep-walk an inbound request body and inline local image files before the
 * wire mappers run. Handles every client shape:
 * - OpenAI `image_url.url` (chat-completions and responses `input_image`)
 * - Anthropic `source` { type: 'url', url } → { type: 'base64', media_type, data }
 * - Gemini `fileData.fileUri` → `inlineData` { mimeType, data }
 *
 * Clients that attach screenshots as VS Code-internal resource URIs
 * (`vscode-resource://…`, `file://…`) otherwise send URLs the upstream can't
 * fetch, which surfaces as an opaque upstream 400. Mutates the parsed body in
 * place (it's fresh from JSON.parse — nothing else holds a reference).
 */
export async function normalizeBodyImages(body: unknown): Promise<void> {
  await walk(body);
}

async function walk(node: unknown): Promise<void> {
  if (Array.isArray(node)) {
    for (const item of node) await walk(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as AnyObj;

  // OpenAI-style image_url { url } — also responses input_image.
  const iu = obj.image_url;
  if (iu && typeof iu === 'object') {
    const iuObj = iu as AnyObj;
    if (typeof iuObj.url === 'string') {
      const resolved = await resolveLocalImageUrl(iuObj.url);
      if (resolved) iuObj.url = resolved;
    }
  }

  // Anthropic image source — { type: 'url', url } → { type: 'base64', ... }.
  const src = obj.source;
  if (src && typeof src === 'object') {
    const s = src as AnyObj;
    if (s.type === 'url' && typeof s.url === 'string') {
      const resolved = await resolveLocalImageUrl(s.url);
      const m = resolved ? DATA_URI.exec(resolved) : null;
      if (m) {
        s.type = 'base64';
        s.media_type = m[1];
        s.data = m[2];
        delete s.url;
      }
    }
  }

  // Gemini fileData { fileUri } → inlineData { mimeType, data }.
  const fd = obj.fileData;
  if (fd && typeof fd === 'object') {
    const f = fd as AnyObj;
    if (typeof f.fileUri === 'string') {
      const resolved = await resolveLocalImageUrl(f.fileUri);
      const m = resolved ? DATA_URI.exec(resolved) : null;
      if (m) {
        delete obj.fileData;
        obj.inlineData = { mimeType: m[1], data: m[2] };
      }
    }
  }

  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === 'object') await walk(v);
  }
}
