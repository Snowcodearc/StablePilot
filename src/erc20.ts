// Base USDC specifics: chain resolution, ERC-20 `transfer` calldata, proposal
// expiry formatting, and the structural self-check applied to the proposal
// before it leaves the plugin.
//
// The proposal envelope itself is built by the official PayBox helpers in
// `paybox.ts`. This module only supplies the Base USDC facts they need, so
// there is exactly one place where the asset address and the ABI encoding live.

import { keccak256Hex } from "./keccak.js";

/** Canonical CAIP-2 identifier for Base mainnet. */
export const BASE_CHAIN = "eip155:8453";

/** Base mainnet chain id, as carried by `eip155:8453`. */
export const BASE_CHAIN_ID = 8453;

/** Official USDC contract on Base mainnet. Only valid on eip155:8453. */
export const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** USDC uses six decimals on Base. */
export const USDC_DECIMALS = 6;

/**
 * ERC-20 `transfer(address,uint256)` selector, derived from Keccak-256 rather
 * than hardcoded, so the encoder cannot silently drift from the ABI.
 */
export const ERC20_TRANSFER_SELECTOR = keccak256Hex("transfer(address,uint256)").slice(0, 10);

/**
 * How long a proposal stays valid. The PayBox helpers default to four minutes
 * and reject anything beyond five; we keep their default.
 */
export const PROPOSAL_TTL_MS = 240_000;

export interface ChainResolution {
  ok: true;
  canonical: string;
  chainId: number;
  label: string;
}

export type ChainResolutionResult = ChainResolution | { ok: false; error: string };

const SUPPORTED_CHAINS: ReadonlyArray<{ input: string } & ChainResolution> = [
  { input: "base", canonical: BASE_CHAIN, chainId: BASE_CHAIN_ID, label: "Base mainnet", ok: true },
  { input: BASE_CHAIN, canonical: BASE_CHAIN, chainId: BASE_CHAIN_ID, label: "Base mainnet", ok: true },
];

/** Resolve a user-supplied chain selector to its canonical identifier. */
export function resolveChain(input: unknown): ChainResolutionResult {
  if (input === undefined || input === null || input === "") {
    return { ok: false, error: 'A chain is required. StablePilot currently supports "base" (Base mainnet) only.' };
  }
  if (typeof input !== "string") {
    return { ok: false, error: "The chain selector must be a string." };
  }
  const match = SUPPORTED_CHAINS.find((chain) => chain.input.toLowerCase() === input.trim().toLowerCase());
  if (!match) {
    return {
      ok: false,
      error: `Chain "${input}" is not supported. StablePilot supports Base mainnet only ("base", or "eip155:8453").`,
    };
  }
  return { ok: true, canonical: match.canonical, chainId: match.chainId, label: match.label };
}

/**
 * Resolve the USDC contract for a canonical chain identifier.
 *
 * The same symbol on another network is a different asset, so the address is
 * keyed by chain and never reused across chains.
 */
export function usdcContractFor(canonicalChain: string): string | null {
  if (canonicalChain === BASE_CHAIN) return USDC_BASE_MAINNET;
  return null;
}

/** ABI-encode an ERC-20 `transfer(address,uint256)` call. */
export function encodeErc20Transfer(recipient: string, atomicAmount: bigint): string {
  const addressWord = recipient.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amountWord = atomicAmount.toString(16).padStart(64, "0");
  return `${ERC20_TRANSFER_SELECTOR}${addressWord}${amountWord}`;
}

/**
 * Format an expiry the way PayBox requires: whole-second UTC RFC3339, derived
 * from the supplied instant so callers stay deterministic and testable.
 */
export function proposalExpiry(now: Date): string {
  return new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface EvmProposalShape {
  chain: string;
  transaction: { to: string; value: string; data: string };
}

/**
 * Structural self-check on the proposal we are about to return.
 *
 * This guards against a regression in the encoder or the constants: if any
 * invariant is violated we fail loudly instead of handing PayBox a malformed
 * proposal that a user might approve.
 */
export function assertEvmProposalInvariants(proposal: EvmProposalShape): void {
  const problems: string[] = [];
  const expectedContract = usdcContractFor(proposal.chain);

  const data = proposal.transaction.data;
  if (expectedContract === null) problems.push("unresolvable chain");
  if (proposal.transaction.to !== expectedContract) problems.push("transaction target is not the USDC contract for the chain");
  if (proposal.transaction.value !== "0") problems.push("native value must be zero for an ERC-20 transfer");
  if (!/^0x(?:[0-9a-f]{2})*$/.test(data)) problems.push("calldata is not lowercase even-length hex");
  if (!data.startsWith(ERC20_TRANSFER_SELECTOR)) problems.push("calldata does not start with the ERC-20 transfer selector");
  if (data.length !== 10 + 64 + 64) {
    problems.push("calldata is not a selector plus two 32-byte words");
  } else if (BigInt(`0x${data.slice(74)}`) <= 0n) {
    // Only reachable once the length is known good, so the slice cannot be
    // truncated into a silently wrong amount.
    problems.push("encoded amount must be positive");
  }

  if (problems.length > 0) {
    throw new Error(`Refusing to emit an invalid transaction proposal: ${problems.join("; ")}`);
  }
}
