// SPDX-License-Identifier: AGPL-3.0-only
// Browser-only test stand-in. No production route imports this module.
/**
 * `next/image` is a CommonJS module that Next.js resolves itself; a plain Vite acceptance bundle (e2e/chat-review-overflow.spec.ts) renders the
 * same image as an ordinary img element with the same source, alternative text, size and class.
 */
import { createElement } from 'react';

type Source = string | { readonly src: string };
export default function Image({ src, alt, width, height, className }: { src: Source; alt: string; width?: number; height?: number; className?: string }) {
  return createElement('img', { src: typeof src === 'string' ? src : src.src, alt, width, height, className });
}
