import { existsSync } from "node:fs";

const [barrier, orgId, reservationId, tokens] = process.argv.slice(2);
const deadline = Date.now() + 5_000;
while (!existsSync(barrier)) {
  if (Date.now() >= deadline) throw new Error("Reservation test barrier timed out");
  await new Promise((resolve) => setTimeout(resolve, 10));
}

try {
  const { reserveTokenQuota } = await import("../../lib/billing.mjs");
  const result = reserveTokenQuota(orgId, reservationId, Number(tokens));
  console.log(JSON.stringify({ ok: true, id: result.id }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, status: error.status || 500, message: error.message }));
}
