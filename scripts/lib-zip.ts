/**
 * Minimal read-only zip index for validate-package.ts — lists entries and inflates one
 * (a .nupkg is a plain zip; nuspec/server.json are small deflate entries). Avoids a
 * dependency for something the central directory format makes trivial.
 */

import { inflateRawSync } from 'zlib';

export interface ZipEntry { name: string; size: number; }

interface Located extends ZipEntry { method: number; compressedSize: number; localHeaderOffset: number; }

export class ZipIndex {
  private readonly entries: Located[];

  constructor(private readonly buf: Buffer) {
    this.entries = ZipIndex.readCentralDirectory(buf);
  }

  list(): ZipEntry[] {
    return this.entries.map(({ name, size }) => ({ name, size }));
  }

  has(name: string): boolean {
    return this.entries.some(e => e.name === name);
  }

  readText(name: string): string | null {
    const e = this.entries.find(x => x.name === name);
    if (!e) return null;
    const h = e.localHeaderOffset;
    if (this.buf.readUInt32LE(h) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const nameLen = this.buf.readUInt16LE(h + 26);
    const extraLen = this.buf.readUInt16LE(h + 28);
    const start = h + 30 + nameLen + extraLen;
    const raw = this.buf.subarray(start, start + e.compressedSize);
    const data = e.method === 0 ? raw : e.method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported compression method ${e.method} for ${name}`);
    return data.toString('utf-8').replace(/^﻿/, '');
  }

  private static readCentralDirectory(buf: Buffer): Located[] {
    // End of central directory record: signature + up to 64K of comment.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const out: Located[] = [];
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
      const method = buf.readUInt16LE(p + 10);
      const compressedSize = buf.readUInt32LE(p + 20);
      const size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localHeaderOffset = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf-8', p + 46, p + 46 + nameLen);
      out.push({ name, size, method, compressedSize, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }
}
