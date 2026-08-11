import type { ContentPart } from './types.js';

/**
 * Flatten content (string or parts) into plain text. Used for providers that
 * don't support multimodal content parts.
 */
export function serializeText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text;
        case 'image':
          return `[image: ${part.imageUrl}]`;
        case 'image-data':
          return `[image: ${part.mimeType}]`;
      }
    })
    .join(' ');
}
