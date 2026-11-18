import { createPublicClient, createWalletClient, erc20Abi, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, WALLET_NETWORK } from "./chain";

/** Send `units` of USDC (6 decimals) on Base from the funder wallet. */
export async function sendUsdc(to: string, units: bigint): Promise<Hex> {
  const transport = http(process.env.BASE_RPC_URL);
  const account = privateKeyToAccount(process.env.FUNDER_PRIVATE_KEY as Hex);
  const wallet = createWalletClient({ account, chain, transport });
  const hash = await wallet.writeContract({
    address: WALLET_NETWORK.tokens[0].address as Hex,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to as Hex, units],
  });
  await createPublicClient({ chain, transport }).waitForTransactionReceipt({ hash });
  return hash;
}
