import { createRoute, z } from "@hono/zod-openapi";
import { type ApiApp, jsonOf, refusals } from "../api/app";
import { ChainNetworkSchema } from "../api/schemas";
import { validateNetworks } from "../chain-networks";
import { walletAddresses } from "../chain-wallet";
import { deploymentSettings } from "../settings";
import { ApiError, errorMessage } from "../worker/http";
import { readConfig } from "../worker/stores";
import { type AgentCall, AgentParams, agentRoute, may } from "./agent";

const ChainWalletSchema = z
  .object({ evm: z.string(), solana: z.string(), networks: z.array(ChainNetworkSchema) })
  .openapi("ChainWallet");

const NetworksPatchSchema = z
  .object({
    networks: z.array(
      ChainNetworkSchema.omit({ id: true }).partial({
        native_symbol: true,
        tokens: true,
        explorer_url: true,
      })
    ),
  })
  .openapi("ChainNetworksPatch");

/** The wallet's addresses, drawn on first read while the capability is on; never its key. */
async function getChainWallet({ env, reg }: AgentCall) {
  const config = await readConfig(env, reg);
  const key = await reg.chainWalletKey(!!config.cap_wallet);
  if (!key) throw new ApiError(404, "the wallet capability is off");
  return { ...walletAddresses(key), networks: await reg.chainNetworks() };
}

/** Replace the networks the wallet reads balances on. */
async function putNetworks({ env, reg }: AgentCall, body: { networks: unknown }) {
  let networks;
  try {
    networks = validateNetworks(body.networks, await deploymentSettings(env));
  } catch (err) {
    throw new ApiError(400, errorMessage(err));
  }
  return { networks: await reg.setChainNetworks(networks) };
}

/** `/chain-wallet`: the Wallet capability's addresses and networks, for the capabilities page. */
export function chainWalletRoutes(app: ApiApp) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/agents/{agentId}/chain-wallet",
      tags: ["Settings"],
      summary: "Read the agent's wallet",
      description:
        "The EVM and Solana addresses of the agent's wallet, which is created on first read while the wallet capability is on, and the networks it reads balances on. The private key is never returned.",
      middleware: [agentRoute(may.member)] as const,
      request: { params: AgentParams },
      responses: { 200: jsonOf(ChainWalletSchema), ...refusals(404) },
    }),
    async (c) => c.json(await getChainWallet(c.var.call), 200)
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/api/agents/{agentId}/chain-wallet/networks",
      tags: ["Settings"],
      summary: "Replace the wallet's networks",
      description:
        "The whole list: each network's RPC URL and the tokens tracked on it. Ids are made from the names.",
      middleware: [agentRoute(may.member)] as const,
      request: {
        params: AgentParams,
        body: { content: { "application/json": { schema: NetworksPatchSchema } } },
      },
      responses: {
        200: jsonOf(z.object({ networks: z.array(ChainNetworkSchema) })),
        ...refusals(400, 404),
      },
    }),
    async (c) => c.json(await putNetworks(c.var.call, c.req.valid("json")), 200)
  );
}
