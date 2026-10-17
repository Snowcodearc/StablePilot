// Minimal, dependency-free Keccak-256 (the pre-standardisation variant used by
// Ethereum, not the NIST SHA3-256 variant, which uses a different padding byte).
//
// Implemented here rather than pulled from npm so that the plugin has no
// runtime dependencies and behaves identically in every sandbox. Correctness is
// pinned by known-answer tests in tests/payment.test.ts, including the ERC-20
// `transfer(address,uint256)` selector that the calldata encoder depends on.

const MASK64 = (1n << 64n) - 1n;

/** Round constants for the 24 rounds of Keccak-f[1600]. */
const ROUND_CONSTANTS = new BigUint64Array([
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]);

/** Rho rotation offsets, indexed as x + 5y. */
const ROTATION_OFFSETS = new Uint8Array([
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
]);

function rotl(value: bigint, shift: number): bigint {
  const v = value & MASK64;
  if (shift === 0) return v;
  const s = BigInt(shift);
  return ((v << s) | (v >> (64n - s))) & MASK64;
}

// Every index into the 25-lane state below is derived from a loop bound of 5 or
// 24, so each access is provably in range; the non-null assertions record that
// rather than adding runtime checks to a hot loop.
function keccakF1600(state: BigUint64Array): void {
  for (let round = 0; round < 24; round += 1) {
    // theta
    const c = new BigUint64Array(5);
    for (let x = 0; x < 5; x += 1) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] = state[x + 5 * y]! ^ d;
    }

    // rho + pi
    const b = new BigUint64Array(25);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const nx = y;
        const ny = (2 * x + 3 * y) % 5;
        b[nx + 5 * ny] = rotl(state[x + 5 * y]!, ROTATION_OFFSETS[x + 5 * y]!);
      }
    }

    // chi
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const next1 = b[((x + 1) % 5) + 5 * y]!;
        const next2 = b[((x + 2) % 5) + 5 * y]!;
        state[x + 5 * y] = b[x + 5 * y]! ^ ((~next1 & MASK64) & next2);
      }
    }

    // iota
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

const RATE_BYTES = 136; // 1088 bits, the Keccak-256 rate.

function absorbBlock(state: BigUint64Array, bytes: Uint8Array, offset: number, length: number): void {
  for (let i = 0; i < length / 8; i += 1) {
    let lane = 0n;
    for (let j = 0; j < 8; j += 1) {
      lane |= BigInt(bytes[offset + i * 8 + j]!) << BigInt(8 * j);
    }
    state[i] = state[i]! ^ lane;
  }
}

/** Keccak-256 of a byte string. Returns 32 bytes. */
export function keccak256(bytes: Uint8Array): Uint8Array {
  const state = new BigUint64Array(25);

  let offset = 0;
  while (offset + RATE_BYTES <= bytes.length) {
    absorbBlock(state, bytes, offset, RATE_BYTES);
    keccakF1600(state);
    offset += RATE_BYTES;
  }

  const finalBlock = new Uint8Array(RATE_BYTES);
  finalBlock.set(bytes.subarray(offset));
  finalBlock[bytes.length - offset] = finalBlock[bytes.length - offset]! ^ 0x01; // Keccak padding
  finalBlock[RATE_BYTES - 1] = finalBlock[RATE_BYTES - 1]! ^ 0x80;
  absorbBlock(state, finalBlock, 0, RATE_BYTES);
  keccakF1600(state);

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i += 1) {
    const lane = state[i]!;
    for (let j = 0; j < 8; j += 1) {
      out[i * 8 + j] = Number((lane >> BigInt(8 * j)) & 0xffn);
    }
  }
  return out;
}

/** UTF-8 encode a string. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Lowercase hex, without a 0x prefix. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Lowercase hex with a 0x prefix. */
export function bytesToHexPrefixed(bytes: Uint8Array): string {
  return `0x${bytesToHex(bytes)}`;
}

/** keccak256 of a UTF-8 string, as a 0x-prefixed hex string. */
export function keccak256Hex(text: string): string {
  return bytesToHexPrefixed(keccak256(utf8(text)));
}
