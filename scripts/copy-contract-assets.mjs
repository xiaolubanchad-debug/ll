import { copyFile, mkdir } from 'node:fs/promises';
const src = new URL('../packages/contracts/src/generated/validators.js', import.meta.url);
const dest = new URL('../packages/contracts/dist/generated/validators.js', import.meta.url);
await mkdir(new URL('../packages/contracts/dist/generated/', import.meta.url), { recursive: true });
await copyFile(src, dest);
