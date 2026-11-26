import { createHash } from "node:crypto";
import {
  type CreateCustomerInput,
  type CreateInvoiceInput,
  type RequestOptions,
  type StripeCustomer,
  StripeError,
  type StripeGateway,
  type StripeInvoice,
} from "./gateway.ts";

export interface RecordedCall {
  operation: "createCustomer" | "createInvoice";
  idempotencyKey: string;
  /** True when the call was answered from the idempotency cache. */
  replayed: boolean;
}

type FailureMode = "before" | "after";

/**
 * Deterministic in-memory Stripe. Resource ids derive from the idempotency key,
 * repeated keys replay the stored response, and a key reused with different
 * parameters is rejected exactly like the real API. Failures can be injected
 * either before the operation takes effect or after it (the ambiguous "timeout
 * after success" case that idempotency keys exist for).
 */
export class FakeStripe implements StripeGateway {
  readonly calls: RecordedCall[] = [];
  readonly customers = new Map<string, CreateCustomerInput>();
  readonly invoices = new Map<string, CreateInvoiceInput>();
  private readonly responses = new Map<string, { fingerprint: string; result: unknown }>();
  private readonly injected: { remaining: number; mode: FailureMode; retryable: boolean }[] = [];

  /** Make the next `count` calls fail. */
  failNext(count: number, options: { mode?: FailureMode; retryable?: boolean } = {}): void {
    this.injected.push({ remaining: count, mode: options.mode ?? "before", retryable: options.retryable ?? true });
  }

  createCustomer(input: CreateCustomerInput, options: RequestOptions): Promise<StripeCustomer> {
    return this.execute("createCustomer", input, options, () => {
      const id = fakeId("cus", options.idempotencyKey);
      this.customers.set(id, input);
      return { id };
    });
  }

  createInvoice(input: CreateInvoiceInput, options: RequestOptions): Promise<StripeInvoice> {
    return this.execute("createInvoice", input, options, () => {
      if (!this.customers.has(input.customerId)) {
        throw new StripeError(`No such customer: ${input.customerId}`, "resource_missing", false);
      }
      const id = fakeId("in", options.idempotencyKey);
      this.invoices.set(id, input);
      return { id, status: "open" as const };
    });
  }

  private async execute<T>(
    operation: RecordedCall["operation"],
    input: unknown,
    options: RequestOptions,
    run: () => T,
  ): Promise<T> {
    const fingerprint = JSON.stringify(input, (_key, value) => (typeof value === "bigint" ? `${value}n` : value));
    const failure = this.nextFailure();
    if (failure?.mode === "before") {
      this.calls.push({ operation, idempotencyKey: options.idempotencyKey, replayed: false });
      throw new StripeError("injected failure", "api_connection_error", failure.retryable);
    }

    const key = `${operation}:${options.idempotencyKey}`;
    const stored = this.responses.get(key);
    let result: T;
    let replayed = false;
    if (stored) {
      if (stored.fingerprint !== fingerprint) {
        throw new StripeError(
          "Keys for idempotent requests can only be used with the same parameters they were first used with.",
          "idempotency_error",
          false,
        );
      }
      result = stored.result as T;
      replayed = true;
    } else {
      result = run();
      this.responses.set(key, { fingerprint, result });
    }
    this.calls.push({ operation, idempotencyKey: options.idempotencyKey, replayed });
    if (failure?.mode === "after") {
      throw new StripeError("injected timeout after success", "api_connection_error", failure.retryable);
    }
    return result;
  }

  private nextFailure(): { mode: FailureMode; retryable: boolean } | undefined {
    const head = this.injected[0];
    if (!head) return undefined;
    head.remaining -= 1;
    if (head.remaining <= 0) this.injected.shift();
    return head;
  }
}

export function fakeId(prefix: string, idempotencyKey: string): string {
  return `${prefix}_fake_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16)}`;
}
