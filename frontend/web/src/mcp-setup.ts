/** Client templates contain only secret references/placeholders, never actual tokens. */
import i18n from './i18n';

function t(key: string, options?: Record<string, unknown>): string {
  const lng = typeof window === 'undefined' ? 'zh' : undefined;
  return i18n.t(key, { lng, ...options });
}

export const mcpClients = {
  codex: 'Codex',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  generic: 'Generic',
} as const;
export type McpClient = keyof typeof mcpClients;
export function mcpSetup(client: McpClient, rawName: string, rawUrl: string, allowHttp: boolean) {
  const name = rawName.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error(t('mcpSetup.namePattern'));
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(t('mcpSetup.urlInvalid'));
  }
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(t('mcpSetup.urlRestrictions'));
  }
  if (parsed.protocol === 'http:' && !allowHttp) {
    throw new Error(t('mcpSetup.allowHttpRequired'));
  }
  const url = parsed.href;
  const variable = `${name.toUpperCase().replaceAll('-', '_')}_MCP_TOKEN`;
  const auth =
    client === 'cursor'
      ? `Bearer \${env:${variable}}`
      : client === 'opencode'
        ? `Bearer {env:${variable}}`
        : 'Bearer REPLACE_WITH_YOUR_TOKEN';
  const config =
    client === 'generic'
      ? ''
      : client === 'codex'
        ? `[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = ${JSON.stringify(variable)}\n`
        : JSON.stringify(
            client === 'opencode'
              ? {
                  mcp: {
                    [name]: {
                      type: 'remote',
                      url,
                      enabled: true,
                      oauth: false,
                      headers: { Authorization: auth },
                    },
                  },
                }
              : {
                  mcpServers: {
                    [name]: {
                      [client === 'antigravity' ? 'serverUrl' : 'url']: url,
                      headers: { Authorization: auth },
                    },
                  },
                },
            null,
            2,
          );
  const instructions = {
    generic: t('mcpSetup.instructionGeneric'),
    codex: t('mcpSetup.instructionCodex', { variable }),
    cursor: t('mcpSetup.instructionCursor', { variable }),
    antigravity: t('mcpSetup.instructionAntigravity'),
    opencode: t('mcpSetup.instructionOpencode', { variable }),
  }[client];
  const clientLabel = client === 'generic' ? t('mcpSetup.clientGeneric') : mcpClients[client];
  const httpNote = parsed.protocol === 'http:' ? `${t('mcpSetup.promptHttpAllowed')}\n` : '';
  const snippet = config
    ? `${t('mcpSetup.promptConfigSnippet')}\n\`\`\`${client === 'codex' ? 'toml' : 'json'}\n${config}\n\`\`\``
    : t('mcpSetup.promptGenericSnippet');
  const prompt = `${t('mcpSetup.promptConnect', { client: clientLabel })}\n${t('mcpSetup.promptConnectionName', { name })}\n${t('mcpSetup.promptMcpUrl', { url })}\n\n${instructions}\n\n${t('mcpSetup.promptCheckExisting')}\n${t('mcpSetup.promptTokenNote')}\n${t('mcpSetup.promptVerify')}\n${t('mcpSetup.promptReport')}\n${httpNote}${snippet}`;
  return { config, prompt, instructions, variable };
}
