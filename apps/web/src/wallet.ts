import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { actionCreators } from "@near-js/transactions";
import "@near-wallet-selector/modal-ui/styles.css";
import { api, setToken, type ContractCall, type PublicConfig } from "./api";

/**
 * The browser wallet is the human's NEAR key. It signs the NEP-413 login and every
 * contract call; the API never receives a key or signs anything.
 */
export interface Wallet {
  selector: WalletSelector;
  modal: WalletSelectorModal;
}

export async function initWallet(config: PublicConfig): Promise<Wallet> {
  const selector = await setupWalletSelector({
    network: config.network === "testnet" ? "testnet" : "mainnet",
    modules: [setupMyNearWallet()],
  });
  const modal = setupModal(selector, { contractId: config.escrowContract });
  return { selector, modal };
}

export function connectedAccount(w: Wallet): string | null {
  return w.selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
}

/** NEP-413 login: the wallet signs the server's challenge; the server checks the key onchain. */
export async function login(w: Wallet, accountId: string): Promise<void> {
  const ch = await api<{ nonce: string; message: string; recipient: string }>("POST", "/v1/auth/challenge", { accountId });
  const wallet = await w.selector.wallet();
  const callbackUrl = `${window.location.origin}/`;
  const signed = await wallet.signMessage({
    message: ch.message,
    recipient: ch.recipient,
    nonce: Buffer.from(ch.nonce, "hex"),
    callbackUrl,
  });
  if (!signed) throw new Error("the wallet did not return a signature");
  const { token } = await api<{ token: string }>("POST", "/v1/auth/verify", {
    accountId,
    publicKey: signed.publicKey,
    signature: signed.signature,
    nonce: ch.nonce,
    kind: "HUMAN",
    callbackUrl,
  });
  setToken(token);
}

/** Signs and sends one contract call with the connected wallet. Returns the transaction hash. */
export async function sendCall(w: Wallet, call: ContractCall): Promise<string> {
  const wallet = await w.selector.wallet();
  const outcome = await wallet.signAndSendTransaction({
    receiverId: call.contractId,
    actions: [actionCreators.functionCall(call.methodName, call.args, BigInt(call.gas), BigInt(call.deposit))],
  });
  const hash = outcome && typeof outcome === "object" && "transaction" in outcome ? (outcome.transaction as { hash?: string }).hash : undefined;
  if (!hash) throw new Error("the wallet did not return a transaction hash");
  return hash;
}

export const explorerTx = (network: string, hash: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;
