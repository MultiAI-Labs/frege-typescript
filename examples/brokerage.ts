/**
 * A support bot for a brokerage: read one customer's account, then their orders,
 * using that customer's own credential at the broker.
 *
 * Run it with:
 *   FREGE_API_KEY=frege_sk_… FREGE_PROJECT_ID=3 FREGE_CLIENT_ID=4021 \
 *     npx tsx examples/brokerage.ts
 */
import { Frege, isFregeError } from '../src/index.js';

const apiKey = process.env.FREGE_API_KEY;
if (!apiKey) throw new Error('set FREGE_API_KEY to a project API key');

const frege = new Frege({
  token: apiKey,
  projectId: Number(process.env.FREGE_PROJECT_ID ?? 3),
});

// Whose account to act on. Frege injects THAT customer's stored credential and
// records both parties — the key that asked, and the account it reached.
const asClient = Number(process.env.FREGE_CLIENT_ID ?? 0) || undefined;

interface Account {
  account_id: string;
  cash: number;
}

interface Order {
  id: string;
  symbol: string;
  quantity: number;
  status: string;
}

try {
  for (const op of await frege.listOperations()) {
    console.log(`${op.toolName.padEnd(24)} ${op.method} ${op.path}`);
  }

  const account = await frege.invoke<Account>('get_account_profile', {}, asClient ? { asClient } : {});
  if (!account.ok) {
    console.error(`the broker refused with ${String(account.status)}: ${account.raw}`);
    process.exit(1);
  }
  // `data` is `Account` only when the upstream really answered JSON. It is the
  // raw string for an HTML maintenance page, and undefined for a 204 — so the
  // type makes you look before you reach into it.
  if (typeof account.data !== 'object') {
    console.error(`the broker did not answer with JSON: ${account.raw.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`account ${account.data.account_id} holds ${String(account.data.cash)} in cash`);

  const orders = await frege.invoke<Order[]>('list_orders', { status: 'open' }, asClient ? { asClient } : {});
  for (const order of orders.ok && Array.isArray(orders.data) ? orders.data : []) {
    console.log(`${order.id} ${order.symbol} x${String(order.quantity)} (${order.status})`);
  }
} catch (err) {
  if (!isFregeError(err)) throw err;
  switch (err.kind) {
    case 'api':
      console.error(`frege said ${String(err.status)} ${err.code}: ${err.message}`);
      if (err.requestId) console.error(`quote request id ${err.requestId} to support`);
      break;
    case 'protocol':
      console.error(`frege answered something this SDK cannot read: ${err.message}`);
      break;
    case 'timeout':
      console.error(`gave up after ${String(err.elapsedMs)}ms of a ${String(err.timeoutMs)}ms budget`);
      break;
    case 'connection':
      console.error('could not reach Frege');
      break;
    case 'task':
      console.error(`task ended ${err.task.status}: ${err.task.statusMessage}`);
      break;
  }
  process.exit(1);
}
