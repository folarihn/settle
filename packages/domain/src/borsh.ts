/** Minimal borsh writer for the layouts the escrow contract hashes or verifies. */
export class BorshWriter {
  private parts: Buffer[] = [];
  string(s: string): this {
    const bytes = Buffer.from(s, "utf8");
    return this.u32(bytes.length).raw(bytes);
  }
  u8(n: number): this {
    return this.raw(Buffer.from([n]));
  }
  u32(n: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return this.raw(b);
  }
  u64(n: number | bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return this.raw(b);
  }
  u128(n: bigint): this {
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(n & 0xffffffffffffffffn);
    b.writeBigUInt64LE(n >> 64n, 8);
    return this.raw(b);
  }
  raw(b: Buffer): this {
    this.parts.push(b);
    return this;
  }
  bytes(): Buffer {
    return Buffer.concat(this.parts);
  }
}
