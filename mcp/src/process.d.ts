// lib/crm-auth.ts (shared with the CRM app) reads process.env.NODE_ENV; this worker runs with nodejs_compat, so only the type is missing.
declare const process: { env: Record<string, string | undefined> };
