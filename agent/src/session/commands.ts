import { enabled, mcpServerReady, withMcpAuth } from "../capabilities";
import type { Command, CommandResult, McpCommand } from "../commands";
import { sessionLimitMessage, type SessionRow } from "../registry";
import { compact } from "./compaction";
import { spendBlocked } from "./turns";
import type { SessionHost } from "./types";

/**
 * Run a bang command and say what it did. A command that ends the session reports first
 * (`destroy`), because destroying the object aborts the isolate.
 */
export async function runCommand(host: SessionHost, command: Command): Promise<CommandResult> {
  if (typeof command === "object") return await mcpCommand(host, command);
  // TEMP, remove with `oom`: allocate until the isolate is killed, logging progress.
  if (command === "oom") {
    // Filled byte buffers, which a runtime cannot represent cleverly the way it can strings.
    const held: Uint8Array[] = [];
    let mb = 0;
    try {
      for (let i = 0; i < 2048; i++) {
        const chunk = new Uint8Array(4 * 1024 * 1024);
        // Written through, so the pages are actually faulted in rather than promised.
        for (let o = 0; o < chunk.length; o += 4096) chunk[o] = (i + o) & 255;
        chunk[chunk.length - 1] = 1;
        held.push(chunk);
        mb += 4;
        if (mb % 16 === 0) {
          console.log(
            `[oom] holding ${mb} MB across ${held.length} buffers in session ${host.name()}`
          );
        }
      }
    } catch (err) {
      // An allocation failure is a real answer: the runtime refused before it was killed.
      console.log(
        `[oom] allocation threw at ${mb} MB: ${err instanceof Error ? err.message : err}`
      );
      return {
        text: `Allocation failed at ${mb} MB: ${err instanceof Error ? err.message : String(err)}`,
        destroy: false,
      };
    }
    return {
      text: `Held ${mb} MB without dying — the limit is not being enforced on this path.`,
      destroy: false,
    };
  }
  if (command === "compact") return await compactCommand(host);
  if (command === "stop") {
    // Counted before the cancel, because cancelling is what makes it zero.
    const running = host.turn.running;
    host.turn.stoppedOnPurpose = true;
    // The same teardown as `!unstick`: a cancelled turn may never settle, and would break
    // every later question.
    host.unstick();
    return {
      text: running
        ? "Stopped. What it had written is kept in the transcript — ask again when you are ready."
        : "Nothing to stop: this session is not answering anything right now.",
      destroy: false,
    };
  }
  if (command === "unstick") {
    host.unstick();
    return {
      text: "Cleared this session's turn state. Everything it holds is still here — ask again.",
      destroy: false,
    };
  }
  if (command === "new" || command === "clear") {
    const row = await host.registry().get(host.sessionId());
    if (!row?.chat_id) {
      return {
        text: "Nothing to move: this session is not tied to a chat. Start a new one from the sidebar.",
        destroy: false,
      };
    }
    return await startOver(host, row, command === "clear");
  }
  await host.registry().remove(host.sessionId());
  return {
    text: "Deleted this session and everything in it. The next message starts over.",
    destroy: true,
  };
}

/**
 * `!compact`: summarise everything but the latest message now. Refused while a reply is
 * being written, and when the month's spend is used up.
 */
export async function compactCommand(host: SessionHost): Promise<CommandResult> {
  if (host.turn.running > 0) {
    return {
      text: "A reply is still being written. Wait for it to finish (or `!stop` it), then `!compact`.",
      destroy: false,
    };
  }
  const blocked = await spendBlocked(host);
  if (blocked) return { text: blocked, destroy: false };
  try {
    await host.loadConfig();
    const done = await compact(host, { head: 0, tailTokens: 0, minTail: 1 });
    if (!done) {
      return {
        text: "Nothing to compact yet: there is no earlier message to summarise.",
        destroy: false,
      };
    }
    if (done.cost > 0) await host.registry().addSpend(done.cost);
    return {
      text:
        `Compacted: ${done.covered} earlier messages are now a summary the agent reads instead. ` +
        "The transcript itself is unchanged.",
      destroy: false,
    };
  } catch (err) {
    return {
      text: `Could not compact: ${err instanceof Error ? err.message : String(err)}`,
      destroy: false,
    };
  }
}

/**
 * `!enable-mcp` / `!disable-mcp`. Enabling turns every tool on and re-reads the tool list
 * so an unreachable server says so now; disabling leaves the selection alone.
 */
export async function mcpCommand(
  host: SessionHost,
  { mcp, server }: McpCommand
): Promise<CommandResult> {
  const reg = host.registry();
  const wanted = server.toLowerCase();
  const row = (await reg.mcpServers()).find((s) => s.name.toLowerCase() === wanted);
  if (mcp === "disable") {
    const done = row && (await reg.updateMcpServer(row.id, { enabled: 0 }));
    return {
      text: done
        ? "Disabled. You can also partially enable a few tools that are required from the web UI."
        : "Error disabling MCP server, please visit the web UI.",
      destroy: false,
    };
  }
  if (!row) return { text: `No MCP server named "${server}".`, destroy: false };
  const updated = await reg.updateMcpServer(row.id, { enabled: 1, disabled_tools: "[]" });
  if (!updated || !mcpServerReady(updated)) {
    return {
      text: `${row.name} is not connected. Connect it from the web UI.`,
      destroy: false,
    };
  }
  try {
    const tools = await withMcpAuth(updated, reg, (client) => client.listTools());
    await reg.updateMcpServer(row.id, {
      tools_json: JSON.stringify(tools),
      tools_synced_at: Date.now(),
      last_error: "",
    });
    await host.loadConfig();
    if (!enabled(host.config(), "mcp")) {
      return {
        text: `${row.name} is enabled, but MCP is switched off for this agent. Turn it on from the web UI.`,
        destroy: false,
      };
    }
    return {
      text:
        `${row.name} enabled with all ${tools.length} tools. This can sharply raise token use — ` +
        `disable it when not needed, or switch off unused tools from the web UI.`,
      destroy: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reg.noteMcpError(row.id, message);
    return { text: `Error connecting to ${row.name}: ${message}`, destroy: false };
  }
}

/**
 * Hand the chat to a fresh session (created now, so scheduled tasks can move onto the
 * session the next message will reach). `discard`: `!clear` drops the old session,
 * `!new` keeps it readable. The old one lets go of the chat before the new one claims it.
 */
export async function startOver(
  host: SessionHost,
  row: SessionRow,
  discard: boolean
): Promise<CommandResult> {
  // Checked before detaching, so a failed create cannot leave the chat orphaned. `!clear`
  // frees its own slot.
  const { max_sessions } = await host.settingsNow();
  if (!discard && (await host.registry().countSessions()) >= max_sessions) {
    return { text: sessionLimitMessage(max_sessions), destroy: false };
  }
  const tasks = host.taskHandover();
  // Named while this row still exists, so the successor cannot be this same object.
  const next = await host
    .registry()
    .freeChatSessionId(
      host.agentId(),
      row.chat_id,
      row.chat_thread_id,
      row.source === "whatsapp" ? "wa" : "tg"
    );
  // Dropping the row also frees a session slot, which is what lets `!clear` work at
  // the ceiling: `create` counts below.
  if (discard) await host.registry().remove(host.sessionId());
  else await host.registry().detachChat(host.sessionId());
  try {
    await host.registry().create(
      next,
      "New session",
      host.env.SessionAgent.idFromName(next).toString(),
      {
        source: row.source,
        chat_id: row.chat_id,
        chat_type: row.chat_type,
        chat_username: row.chat_username,
        chat_thread_id: row.chat_thread_id,
      },
      max_sessions
    );
  } catch (err) {
    // Only if the agent filled up since the check; say what state the chat is in.
    return {
      text: discard
        ? `${(err as Error).message} This conversation has been deleted; send a message to start a new one.`
        : `${(err as Error).message} This conversation has been closed; delete a session and send a message to start a new one.`,
      destroy: discard,
    };
  }

  const opening = discard
    ? "Starting fresh. This conversation and everything in it has been deleted; anything said here from now on goes to a new session."
    : "Starting fresh. This conversation is kept and still readable in the browser; anything said here from now on goes to a new session.";
  if (tasks.length === 0) return { text: opening, destroy: discard };

  try {
    const stub = host.env.SessionAgent.get(host.env.SessionAgent.idFromName(next));
    const { moved, failed } = await stub.adoptTasks(tasks);
    // Only what the successor actually took on is dropped here, so a task that
    // could not be re-created still runs somewhere rather than nowhere.
    if (moved > 0) for (const task of host.listTasks()) await host.cancelTask(task.id);
    const carried = `${moved} scheduled ${moved === 1 ? "task" : "tasks"} moved across.`;
    return {
      text:
        failed > 0
          ? `${opening}\n\n${carried} ${failed} could not be — their time has passed.`
          : `${opening}\n\n${carried}`,
      destroy: discard,
    };
  } catch (err) {
    console.error(
      `task handover failed from ${host.name()} to ${next}: ${err instanceof Error ? err.message : String(err)}`
    );
    return {
      text: discard
        ? `${opening}\n\nIts scheduled tasks could not be moved and go with it.`
        : `${opening}\n\nIts scheduled tasks could not be moved and stay with the old session.`,
      destroy: discard,
    };
  }
}
