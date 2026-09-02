/**
 * A minimal, dependency-free ZIP writer (STORED / no compression) — enough to
 * package an FMU (`.fmu` is a ZIP archive). Emits a plain STORED archive with
 * per-entry CRC-32, so any standard unzip / FMI importer accepts it. Compression
 * is intentionally omitted: FMU payloads here are small XML files and STORED
 * keeps this a ~60-line, browser-safe, zero-dependency encoder.
 */

/** One file to place in the archive. */
export interface ZipEntry {
  /** Archive path (use forward slashes), e.g. `modelDescription.xml`. */
  name: string;
  data: Uint8Array;
}

/* ─────────────────────────────── CRC-32 ──────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3) of a byte array. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ─────────────────────────────── writer ──────────────────────────────── */

/** A growable little-endian byte buffer. */
class ByteBuf {
  private bytes: number[] = [];
  get length(): number {
    return this.bytes.length;
  }
  u16(v: number): void {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff);
  }
  u32(v: number): void {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  raw(b: Uint8Array): void {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i]);
  }
  toUint8(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/**
 * Build a STORED ZIP archive from `entries`. Timestamps are fixed at zero so the
 * output is byte-for-byte deterministic (stable tests, reproducible FMUs).
 */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const local = new ByteBuf();
  const central = new ByteBuf();
  const records: Array<{ name: Uint8Array; crc: number; size: number; offset: number }> = [];

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const offset = local.length;
    local.u32(0x04034b50); // local file header signature
    local.u16(20); // version needed
    local.u16(0x0800); // general-purpose flags: bit 11 = filenames are UTF-8
    local.u16(0); // compression method: 0 = stored
    local.u16(0); // mod time
    local.u16(0); // mod date
    local.u32(crc);
    local.u32(e.data.length); // compressed size == uncompressed (stored)
    local.u32(e.data.length);
    local.u16(name.length);
    local.u16(0); // extra field length
    local.raw(name);
    local.raw(e.data);
    records.push({ name, crc, size: e.data.length, offset });
  }

  const centralStart = local.length;
  for (const r of records) {
    central.u32(0x02014b50); // central directory header signature
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0x0800); // flags: bit 11 = filenames are UTF-8
    central.u16(0); // compression
    central.u16(0); // mod time
    central.u16(0); // mod date
    central.u32(r.crc);
    central.u32(r.size);
    central.u32(r.size);
    central.u16(r.name.length);
    central.u16(0); // extra
    central.u16(0); // comment length
    central.u16(0); // disk number start
    central.u16(0); // internal attributes
    central.u32(0); // external attributes
    central.u32(r.offset);
    central.raw(r.name);
  }
  const centralSize = central.length;

  const eocd = new ByteBuf();
  eocd.u32(0x06054b50); // end of central directory signature
  eocd.u16(0); // this disk
  eocd.u16(0); // disk with central directory
  eocd.u16(records.length); // entries on this disk
  eocd.u16(records.length); // total entries
  eocd.u32(centralSize);
  eocd.u32(centralStart);
  eocd.u16(0); // comment length

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local.toUint8(), 0);
  out.set(central.toUint8(), local.length);
  out.set(eocd.toUint8(), local.length + central.length);
  return out;
}

/* ─────────────────────────────── reader ──────────────────────────────── */

/**
 * Read a ZIP archive's entries, returning `name → bytes`. Only STORED (method 0)
 * entries are supported — enough to read an FMU this tool produced. A DEFLATE
 * (compressed) entry throws, since inflate is intentionally not bundled.
 */
export function unzipStored(bytes: Uint8Array): Record<string, Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find the End Of Central Directory (scan back for its signature; the trailing
  // comment is empty for our archives but scanning is robust either way).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: Record<string, Uint8Array> = {};
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + nameLen));
    if (method !== 0) {
      throw new Error(`ZIP entry "${name}" is compressed (method ${method}); only STORED is supported.`);
    }
    // The data follows the local header (30 bytes + its own name + extra fields).
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lNameLen + lExtraLen;
    out[name] = bytes.slice(start, start + size);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
