// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

it('ships the original licensed product font payloads with exact digests and all Latin preload files available offline', async () => {
  const root = new URL('../../public/fonts/',import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json',root),'utf8')) as { files: {file:string;sha256:string;bytes:number}[];preload:string[] };
  expect(manifest.files).toHaveLength(12);
  for(const entry of manifest.files){
    const data = await readFile(new URL(entry.file,root));
    expect(data.subarray(0,4).toString()).toBe('wOF2');
    expect(createHash('sha256').update(data).digest('hex')).toBe(entry.sha256);
    expect(data.length).toBe(entry.bytes);
  }
  for(const file of manifest.preload) expect(manifest.files.some(entry=>entry.file===file)).toBe(true);
  for(const file of ['Outfit.OFL.txt','IBM-Plex-Mono.OFL.txt']) expect(await readFile(new URL(file,root),'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
});
