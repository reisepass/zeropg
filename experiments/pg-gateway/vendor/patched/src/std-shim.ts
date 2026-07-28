// PATCH 3 of 3: replaces the four @std/* imports with node: builtins.
//
// Motivation, from the vendoring plan: the shipped dist inlines
// @std/crypto/_wasm, a 196 KB base64 wasm-bindgen Rust module compiled by an
// April-2024 toolchain that we cannot audit or rebuild. Removing it is the whole
// supply-chain argument.
//
// The audit turned out smaller than budgeted. Only FOUR symbols are used across
// the entire library, and only ONE of them (md5) actually reaches @std/crypto:
//
//   @std/bytes/copy       -> copy()          buffer-writer.ts, message-buffer.ts
//   @std/bytes/concat     -> concat()        auth/md5.ts
//   @std/encoding/hex     -> encodeHex()     auth/md5.ts
//   @std/encoding/base64  -> decode/encodeBase64()  auth/sasl/scram-sha-256.ts
//   @std/crypto           -> crypto.subtle.digest('MD5')  auth/md5.ts ONLY
//
// SCRAM-SHA-256, the reason we want this library at all, does NOT touch
// @std/crypto - src/crypto.ts already uses the global Web Crypto SubtleCrypto for
// pbkdf2/HMAC/digest. The WASM blob exists solely because Web Crypto has no MD5,
// and MD5 is the legacy auth method we do not intend to offer.
//
// So the "~60 LOC and a supply-chain audit" line item is this file, and Node's
// crypto.createHash('md5') covers the one real gap.

import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

/** @std/bytes/copy */
export function copy(src: Uint8Array, dst: Uint8Array, off = 0): number {
  off = Math.max(0, Math.min(off, dst.byteLength))
  const dstBytesAvailable = dst.byteLength - off
  if (src.byteLength > dstBytesAvailable) {
    src = src.subarray(0, dstBytesAvailable)
  }
  dst.set(src, off)
  return src.byteLength
}

/** @std/bytes/concat */
export function concat(buffers: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const buffer of buffers) length += buffer.length
  const output = new Uint8Array(length)
  let index = 0
  for (const buffer of buffers) {
    output.set(buffer, index)
    index += buffer.length
  }
  return output
}

/** @std/encoding/hex */
export function encodeHex(src: string | Uint8Array | ArrayBuffer): string {
  const u8 =
    typeof src === 'string'
      ? new TextEncoder().encode(src)
      : src instanceof ArrayBuffer
        ? new Uint8Array(src)
        : src
  return Buffer.from(u8).toString('hex')
}

/** @std/encoding/base64 */
export function encodeBase64(data: ArrayBuffer | Uint8Array | string): string {
  const u8 =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data
  return Buffer.from(u8).toString('base64')
}

/** @std/encoding/base64 */
export function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

// @std/crypto's `crypto` export is a SubtleCrypto superset supporting MD5 via
// WASM. We delegate everything to the global Web Crypto and special-case MD5
// through node:crypto, which is the only reason the WASM module was there.
//
// Gotcha found by the regression test: md5.ts imports this as `crypto` and thereby
// SHADOWS the global, then calls `crypto.getRandomValues()` in generateMd5Salt().
// A shim exposing only `subtle` makes that a TypeError, which surfaces as
// "server closed the connection unexpectedly" rather than anything MD5-shaped.
// So the shim must spread the global, not replace it.
export const crypto = {
  ...globalThis.crypto,
  getRandomValues: <T extends ArrayBufferView | null>(array: T): T =>
    globalThis.crypto.getRandomValues(array as never) as T,
  subtle: {
    async digest(
      algorithm: string | { name: string },
      data: BufferSource | Iterable<Uint8Array>,
    ): Promise<ArrayBuffer> {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name
      let bytes: Uint8Array
      if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data)
      } else {
        bytes = concat([...(data as Iterable<Uint8Array>)])
      }

      if (name.toUpperCase() === 'MD5') {
        const h = createHash('md5').update(bytes).digest()
        return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength) as ArrayBuffer
      }
      return globalThis.crypto.subtle.digest(name, bytes)
    },
  },
}
