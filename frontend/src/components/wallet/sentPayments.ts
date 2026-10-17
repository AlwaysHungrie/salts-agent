/**
 * Payments sent from this browser that the Worker has not delivered a key for yet, kept
 * so a refresh, a closed tab or a network that was down doesn't strand them: the wallet
 * checks them again when it next opens.
 */
export type SentPayment = { network: string; tx: string };

const STORE = "salts.sent-payments";

export function sentPayments(): SentPayment[] {
  try {
    const list = JSON.parse(
      localStorage.getItem(STORE) ?? "[]",
    ) as SentPayment[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: SentPayment[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    // Storage blocked: the buyer can still paste the transaction id.
  }
}

export function rememberPayment(sent: SentPayment) {
  write([...sentPayments().filter((p) => p.tx !== sent.tx), sent]);
}

export function forgetPayment(tx: string) {
  write(sentPayments().filter((p) => p.tx !== tx));
}
