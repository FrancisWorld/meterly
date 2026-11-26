/** The only surface of Stripe that Meterly depends on. */
export interface StripeGateway {
  createCustomer(input: CreateCustomerInput, options: RequestOptions): Promise<StripeCustomer>;
  createInvoice(input: CreateInvoiceInput, options: RequestOptions): Promise<StripeInvoice>;
}

export interface RequestOptions {
  /** Stripe replays the original response for a repeated key with identical parameters. */
  idempotencyKey: string;
}

export interface CreateCustomerInput {
  name: string;
  email: string | null;
  metadata: Record<string, string>;
}

export interface StripeCustomer {
  id: string;
}

export interface InvoiceLineInput {
  description: string;
  amountMinor: bigint;
}

export interface CreateInvoiceInput {
  customerId: string;
  currency: string;
  lines: InvoiceLineInput[];
  metadata: Record<string, string>;
}

export interface StripeInvoice {
  id: string;
  status: "open";
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Transient failures (network, 5xx, rate limit) are retried; permanent ones are not. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "StripeError";
  }
}
