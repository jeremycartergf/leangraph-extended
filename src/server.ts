// LeanGraph Server - Entry Point

import { createServer as createLeanGraphServer } from "./routes.js";

export { parse } from "./parser.js";
export type {
  Query,
  Clause,
  CreateClause,
  MatchClause,
  MergeClause,
  SetClause,
  DeleteClause,
  ReturnClause,
  NodePattern,
  RelationshipPattern,
  EdgePattern,
  WhereCondition,
  Expression,
  PropertyValue,
  ParameterRef,
  ParseResult,
  ParseError,
} from "./parser.js";

export { translate, Translator } from "./translator.js";
export type { SqlStatement, TranslationResult } from "./translator.js";

export { GraphDatabase, DatabaseManager } from "./db.js";
export type { Node, Edge, NodeRow, EdgeRow, QueryResult } from "./db.js";

export { Executor, executeQuery } from "./executor.js";
export type { ExecutionResult, ExecutionError, QueryResponse } from "./executor.js";

export { createApp, createServer } from "./routes.js";
export type { QueryRequest, ServerOptions } from "./routes.js";

export { BackupManager } from "./backup.js";
export type { BackupResult, BackupStatus, BackupAllOptions } from "./backup.js";

export { ApiKeyStore, authMiddleware, generateApiKey } from "./auth.js";
export type { ApiKeyConfig, ValidationResult, KeyInfo } from "./auth.js";

export const VERSION = "0.1.0";

function startServer(): void {
  const { serve } = require("@hono/node-server") as typeof import("@hono/node-server");
  const port = parseInt(process.env.PORT || "3000", 10);
  const dataPath = process.env.LEANGRAPH_DATA_PATH || "./data";

  const { app } = createLeanGraphServer({ port, dataPath });

  console.log(`LeanGraph Server v${VERSION}`);
  console.log(`Starting on http://localhost:${port}`);
  console.log(`Data path: ${dataPath}`);

  serve({
    fetch: app.fetch,
    port,
  });
}

// If this file is run directly, start the server
if (require.main === module) {
  startServer();
}
