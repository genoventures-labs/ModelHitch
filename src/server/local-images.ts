import { readFile, stat } from 'node:fs/promises';
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

/** MIME types we will actually inline from disk — image content only. */
const IMAGE_MIME = new Set(Object.values(MIME_BY_EXT));

/** Per-file cap for inlining. Base64 inflates ~1.37×; 20 MiB keeps a handful
 *  of screenshots comfortably under the 64 MiB body cap. */
export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Inlining local files turns the bridge into a local-file reader, so every
 * gate is defensive:
 * - scheme must be `file` or `vscode-resource`
 * - `vscode-resource` authority must be exactly `file` (remote/webview
 *   authorities are never touched)
 * - `file` authority must be empty or `file` (no `file://c:/…` shortcut forms)
 * - the file must exist, be a regular file, be non-empty, and be ≤ maxBytes
 * - the extension must map to a recognized image MIME
 * - the file's actual bytes must sniff to EXACTLY that MIME (a `key.png` that
 *   is really an SSH key fails here)
 * Anything that fails any gate is left untouched for the upstream — the bridge
 * never reads a file it can't prove is an image.
 */
export interface InlineImageOptions {
  /** Max bytes per inlined image. Default MAX_INLINE_IMAGE_BYTES (20 MiB). */
  maxBytes?: number;
}

const DATA_URI = /^data:([^;,]+);base64,(.+)$/s;

/**
 * Parse a URI into a candidate local path, or `undefined` when the scheme or
 * authority isn't on the allow-list. Deliberately narrow: we only accept the
 * exact forms VS Code clients emit for LOCAL resources.
 */
function localPathFromUri(uri: string): string | undefined {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(uri);
  if (!m) return undefined;
  const scheme = m[1]!.toLowerCase();
  const authority = m[2] ?? '';
  const rest = m[3] ?? '';
  if (scheme === 'file') {
    // file:///c:/… or file://file/c:/… — empty or "file" authority only.
    if (authority !== '' && authority.toLowerCase() !== 'file') return undefined;
  } else if (scheme === 'vscode-resource') {
    // vscode-resource://file/c:/… — the local-resource form. Remote/webview
    // authorities (ssh-remote+…, hashes) are explicitly NOT local files.
    if (authority.toLowerCase() !== 'file') return undefined;
  } else {
    return undefined;
  }
  let p: string;
  try {
    p = decodeURIComponent(rest);
  } catch {
    return undefined; // malformed percent-encoding
  }
  // Collapse leading slashes (file:////tmp/x.png is still /tmp/x.png).
  p = p.replace(/^\/+/, '/');
  // Windows drive letter: /c:/x → c:/x (drop the leading separator).
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return p;
}

/**
 * Sniff image type from magic bytes. Returns the MIME only for content we
 * positively recognize — anything else is not an image we inline.
 */
function sniffImageMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const head = buf.toString('ascii', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.length >= 12) {
    const brand = buf.toString('ascii', 8, 12);
    if (buf.toString('ascii', 4, 8) === 'ftyp' && (brand === 'avif' || brand === 'avis')) return 'image/avif';
  }
  if (buf.length >= 5) {
    const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).trimStart();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
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
 * - file:// or vscode-resource://file/ pointing at an existing local IMAGE:
 *   read it and return an inline base64 data URI
 * - anything else (unresolvable, not an image, wrong scheme, over the size
 *   cap, MIME mismatch): `undefined` — the caller keeps the original URL.
 */
export async function resolveLocalImageUrl(
  url: string | undefined,
  opts?: InlineImageOptions,
): Promise<string | undefined> {
  if (!url) return undefined;
  if (/^data:/i.test(url) || /^https?:\/\//i.test(url)) return url;
  const local = localPathFromUri(url);
  if (!local) return undefined;
  const maxBytes = opts?.maxBytes ?? MAX_INLINE_IMAGE_BYTES;
  try {
    const st = await stat(local);
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) return undefined;
    const extMime = mimeFromPath(local);
    if (!IMAGE_MIME.has(extMime)) return undefined; // only known image extensions
    const buf = await readFile(local);
    const sniffed = sniffImageMime(buf);
    if (!sniffed || sniffed !== extMime) return undefined; // bytes must match the extension
    return `data:${sniffed};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

type AnyObj = Record<string, unknown>;

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
 *
 * Security: only files that pass EVERY gate in `resolveLocalImageUrl`
 * (scheme/authority allow-list, regular file, size cap, image extension,
 * magic-byte MIME match) are ever read. Anything else is left untouched.
 */
export async function normalizeBodyImages(body: unknown, opts?: InlineImageOptions): Promise<void> {
  await walk(body, opts);
}

async function walk(node: unknown, opts?: InlineImageOptions): Promise<void> {
  if (Array.isArray(node)) {
    for (const item of node) await walk(item, opts);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as AnyObj;

  // OpenAI-style image_url — BOTH shapes: the spec's { url } object and the
  // VS Code Copilot extension's bare URL string (its Responses request
  // builder emits `image_url: imageUrl.url`). The string form is exactly what
  // v0.5.2's inlining missed, so `vscode-resource://` screenshots kept
  // flowing through to the upstream and surfaced as an opaque 400.
  const iu = obj.image_url;
  if (typeof iu === 'string') {
    const resolved = await resolveLocalImageUrl(iu, opts);
    if (resolved) obj.image_url = resolved;
  } else if (iu && typeof iu === 'object') {
    const iuObj = iu as AnyObj;
    if (typeof iuObj.url === 'string') {
      const resolved = await resolveLocalImageUrl(iuObj.url, opts);
      if (resolved) iuObj.url = resolved;
    }
  }

  // Anthropic image source — { type: 'url', url } → { type: 'base64', ... }.
  const src = obj.source;
  if (src && typeof src === 'object') {
    const s = src as AnyObj;
    if (s.type === 'url' && typeof s.url === 'string') {
      const resolved = await resolveLocalImageUrl(s.url, opts);
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
      const resolved = await resolveLocalImageUrl(f.fileUri, opts);
      const m = resolved ? DATA_URI.exec(resolved) : null;
      if (m) {
        delete obj.fileData;
        obj.inlineData = { mimeType: m[1], data: m[2] };
      }
    }
  }

  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === 'object') await walk(v, opts);
  }
}
