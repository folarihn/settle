#!/usr/bin/env node
/**
 * SETTLE MCP server over stdio. Configure it in an MCP client (Claude Desktop, Claude Code,
 * Cursor, ...) with the agent's own testnet account:
 *
 *   SETTLE_API_URL=https://settle-9ewd.onrender.com
 *   NEAR_ACCOUNT_ID=<agent>.testnet
 *   NEAR_PRIVATE_KEY=ed25519:...        (from the agent's secret store; never commit it)
 *   SETTLE_MAX_AGREEMENT_NEAR=1         (optional spending limit per agreement, default 1)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SettleAgent } from "@settle/agent-sdk";
import { createSettleMcpServer } from "./tools.js";
import { nearToYocto } from "./units.js";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const key = env("NEAR_PRIVATE_KEY");
if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(key)) throw new Error("NEAR_PRIVATE_KEY must be ed25519:<base58>");
const accountId = env("NEAR_ACCOUNT_ID");
if (!accountId.endsWith(".testnet")) throw new Error("NEAR_ACCOUNT_ID must be a .testnet account");

const agent = await SettleAgent.connect({ apiUrl: env("SETTLE_API_URL"), accountId, privateKey: key as `ed25519:${string}` });
const server = await createSettleMcpServer(agent, { maxAgreementYocto: BigInt(nearToYocto(process.env.SETTLE_MAX_AGREEMENT_NEAR ?? "1")) });
await server.connect(new StdioServerTransport());
// stdout carries the protocol; logs go to stderr.
console.error(`settle MCP server ready for ${accountId}`);
