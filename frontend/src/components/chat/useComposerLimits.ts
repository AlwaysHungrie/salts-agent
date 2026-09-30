import { useEffect, useState } from "react";
import {
  agentIdOf,
  capabilityReady,
  type Capability,
  type ClientLimits,
  type Config,
} from "@/lib/agent";
import { apiFetch } from "@/lib/identity";

/**
 * What the composer may offer: the agent's ready input capabilities, and the
 * deployment's ceilings (files per message, image size, recording length) from
 * `/config`. `limits` is null until it answers, and uploads and recording wait for it.
 * The session id names the agent, so nothing extra is threaded down.
 */
export function useComposerLimits(sessionId: string) {
  const [ready, setReady] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<ClientLimits | null>(null);

  useEffect(() => {
    void (async () => {
      const agentId = agentIdOf(sessionId);
      if (!agentId) return;
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentId)}/config`,
      );
      const payload = (await res.json().catch(() => null)) as {
        config: Config;
        capabilities: Capability[];
        limits: ClientLimits;
      } | null;
      if (!payload?.config) return;
      setLimits(payload.limits);
      setReady(
        new Set(
          payload.capabilities
            .filter((c) => capabilityReady(c, payload.config))
            .map((c) => c.id),
        ),
      );
    })();
  }, [sessionId]);

  return { ready, limits };
}
