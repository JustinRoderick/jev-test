import { Context, Layer, Redacted } from "effect";
import { ENV } from "varlock/env";
import path from "node:path";

export function readConfig() {
  const config = {
    mode: (ENV.AI_MODE ?? "fixture") as "fixture" | "live",
    typesafeKey: Redacted.make(ENV.TYPESAFE_API_KEY || ""),
    typesafeModel: ENV.TYPESAFE_MODEL ?? "jev-1.13.0",
    openrouterKey: Redacted.make(ENV.OPENROUTER_API_KEY || ""),
    openrouterModel: ENV.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna",
    databricksHost: ENV.DATABRICKS_HOST || "",
    databricksToken: Redacted.make(ENV.DATABRICKS_TOKEN || ""),
    dataDir: path.resolve(ENV.APP_DATA_DIR ?? ".data"),
    maxUploadBytes: ENV.MAX_UPLOAD_BYTES ?? 26214400,
    runTimeout: ENV.RUN_TIMEOUT_SECONDS ?? 300,
    modelAttempts: ENV.MODEL_MAX_ATTEMPTS ?? 3,
    modelConcurrency: ENV.MODEL_CONCURRENCY ?? 2,
    modelRPM: ENV.MODEL_REQUESTS_PER_MINUTE ?? 60,
    contextBudget: ENV.MODEL_CONTEXT_BUDGET ?? 8000,
    statementTimeout: ENV.DATABRICKS_STATEMENT_TIMEOUT_SECONDS ?? 120,
  };
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0))
      throw new Error(`Configuration ${key} must be a positive integer.`);
  }
  return config;
}
export type Config = ReturnType<typeof readConfig>;
export class AppConfig extends Context.Service<AppConfig, Config>()("silverline/AppConfig") {}
export const ConfigLive = () => Layer.succeed(AppConfig, readConfig());
