export type ProductDemoErrorCode =
  | "aborted"
  | "configuration_error"
  | "connection_error"
  | "invalid_response"
  | "request_failed"
  | "timeout";

export class ProductDemoError extends Error {
  public readonly code: ProductDemoErrorCode;
  public readonly status: number | undefined;
  public readonly requestId: string | undefined;
  public readonly retryAfterSeconds: number | undefined;

  public constructor(
    message: string,
    options: {
      code: ProductDemoErrorCode;
      status?: number;
      requestId?: string;
      retryAfterSeconds?: number;
      cause?: unknown;
    }
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProductDemoError";
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class ProductDemoApiError extends ProductDemoError {
  public constructor(
    message: string,
    options: {
      status: number;
      requestId?: string;
      retryAfterSeconds?: number;
    }
  ) {
    super(message, { code: "request_failed", ...options });
    this.name = "ProductDemoApiError";
  }
}

export function isProductDemoError(error: unknown): error is ProductDemoError {
  return error instanceof ProductDemoError;
}
