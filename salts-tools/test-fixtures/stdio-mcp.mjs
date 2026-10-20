// A stdio MCP server for the bridge's tests: counts initializes, echoes tool calls, and
// asks the client a question of its own before answering `ask_client`.
import readline from "node:readline";

let initializes = 0;
let notified = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const waiting = new Map();

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    // The answer to our own question.
    waiting.get(message.id)?.(message);
    return;
  }
  if (message.method === "notifications/initialized") return void notified++;
  if (message.method === "initialize") {
    initializes++;
    return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", instructions: "be kind" } });
  }
  if (message.method === "tools/call" && message.params?.name === "stats") {
    return send({ jsonrpc: "2.0", id: message.id, result: { initializes, notified } });
  }
  if (message.method === "tools/call" && message.params?.name === "ask_client") {
    waiting.set("q1", (answer) => send({ jsonrpc: "2.0", id: message.id, result: { refused: answer.error?.code } }));
    return send({ jsonrpc: "2.0", id: "q1", method: "sampling/createMessage", params: {} });
  }
  if (message.method === "tools/call" && message.params?.name === "never") return;
  send({ jsonrpc: "2.0", id: message.id, result: { echo: message.params, seenId: message.id } });
});
