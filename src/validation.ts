// Recipient address validation.
//
// Beyond the 20-byte hex shape, we verify the EIP-55 mixed-case checksum. A
// mixed-case address with a wrong checksum is almost always a transcription
// error, and in a payment plugin that is the difference between paying the
// intended recipient and paying a stranger.

import { keccak256Hex } from "./keccak.js";

export type AddressValidation =
  | { ok: true; address: string; checksum: "verified" | "not-applicable" }
  | { ok: false; error: string };

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55 checksum encoding of an address. */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  const hash = keccak256Hex(lower);
  let out = "0x";
  for (let i = 0; i < lower.length; i += 1) {
    const char = lower.charAt(i);
    if (char >= "0" && char <= "9") {
      out += char;
    } else {
      const nibble = Number.parseInt(hash.charAt(i + 2), 16);
      out += nibble >= 8 ? char.toUpperCase() : char;
    }
  }
  return out;
}

/**
 * Validate a recipient address.
 *
 * All-lowercase and all-uppercase forms carry no checksum information, so they
 * are accepted on shape alone. Mixed-case forms must match their EIP-55
 * checksum, otherwise the user is asked to re-check the address.
 */
export function validateRecipient(input: unknown): AddressValidation {
  if (input === undefined || input === null) {
    return { ok: false, error: "A recipient address is required." };
  }
  if (typeof input !== "string") {
    return { ok: false, error: "The recipient address must be a string." };
  }
  const address = input.trim();
  if (address.length === 0) {
    return { ok: false, error: "A recipient address is required." };
  }
  if (!address.startsWith("0x")) {
    return { ok: false, error: `"${address}" is not an EVM address. It must start with "0x".` };
  }
  if (address.length !== 42) {
    return {
      ok: false,
      error: `"${address}" has ${address.length - 2} hex characters. An EVM address has exactly 40.`,
    };
  }
  if (!ADDRESS_PATTERN.test(address)) {
    return { ok: false, error: `"${address}" contains characters that are not hexadecimal.` };
  }

  const body = address.slice(2);
  const hasUpper = /[A-F]/.test(body);
  const hasLower = /[a-f]/.test(body);
  if (hasUpper && hasLower) {
    const expected = toChecksumAddress(address);
    if (expected !== address) {
      return {
        ok: false,
        error:
          `"${address}" fails its EIP-55 checksum, which usually means a typo. ` +
          `The checksummed form is "${expected}".`,
      };
    }
    return { ok: true, address, checksum: "verified" };
  }

  return { ok: true, address: toChecksumAddress(address), checksum: "not-applicable" };
}
