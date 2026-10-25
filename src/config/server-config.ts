/** @fileoverview Lazy server-specific environment configuration. @module config/server-config */
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  ldaApiKey: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional LDA API token; never log this value.'),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe('Enable deletion of staged dataframe tables.'),
});

/** Validated configuration kept separate from framework configuration. */
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
let config: ServerConfig | undefined;

/** Parse lazily; call during application setup to reject invalid configuration before serving. */
export function getServerConfig(): ServerConfig {
  config ??= parseEnvConfig(ServerConfigSchema, {
    ldaApiKey: 'USLOBBYING_LDA_API_KEY',
    dataframeDropEnabled: 'USLOBBYING_DATAFRAME_DROP_ENABLED',
  });
  return config;
}
