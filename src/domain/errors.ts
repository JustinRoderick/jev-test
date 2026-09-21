import { Schema } from "effect";

export class AppError extends Schema.TaggedError<AppError>()("AppError", {
  message: Schema.String,
  code: Schema.String,
  retryable: Schema.Boolean,
}) {}
export const appError = (message: string, code = "INTERNAL", retryable = false) =>
  new AppError({ message, code, retryable });
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
