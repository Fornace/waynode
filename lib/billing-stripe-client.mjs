import Stripe from "stripe";
import { billingEnabled, config } from "./config.mjs";

const stripe = billingEnabled ? new Stripe(config.stripe.secretKey) : null;

export class BillingNotConfiguredError extends Error {
  constructor() {
    super("Billing is not configured on this deployment");
    this.name = "BillingNotConfiguredError";
    this.status = 404;
  }
}

export function requireStripe() {
  if (!stripe) throw new BillingNotConfiguredError();
  return stripe;
}
