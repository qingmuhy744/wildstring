/** Client templates contain only secret references/placeholders, never actual tokens. */
export const mcpClients = {
  codex: 'Codex',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  generic: '通用 MCP 客户端',
} as const;
export type McpClient = keyof typeof mcpClients;
export function mcpSetup(client: McpClient, rawName: string, rawUrl: string, allowHttp: boolean) {
  const name = rawName.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error('连接名称以英文字母开头，可包含字母、数字、下划线和短横线，最多 64 字符。');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('请输入完整的 MCP 地址，例如 https://music.example.com/mcp。');
  }
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('MCP 地址只支持 HTTP/HTTPS，不能包含账号、密码、查询参数或片段。');
  }
  if (parsed.protocol === 'http:' && !allowHttp) {
    throw new Error('使用 HTTP 前，请明确允许这条线路。');
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
    generic:
      '先识别我正在使用的 MCP 客户端及其版本，查阅该客户端官方配置格式与安全凭据输入方式，再添加连接。不要假设它兼容任何其他客户端的配置文件。',
    codex: `使用当前用户的 Codex config.toml（默认 ~/.codex/config.toml，尊重 CODEX_HOME）。令牌从运行 Codex 的进程环境变量 ${variable} 读取。`,
    cursor: `使用当前用户的 Cursor MCP 配置（通常 ~/.cursor/mcp.json）。令牌从运行 Cursor 的进程环境变量 ${variable} 读取；远程 MCP 不支持 envFile。`,
    antigravity:
      '使用 Antigravity 的 MCP Servers → Manage MCP Servers → View raw config 所指向的 mcp_config.json。Bearer 占位符须由我在本机私有配置中替换。不要假设该客户端支持其他工具的环境变量插值语法。',
    opencode: `使用当前用户的 OpenCode 配置（通常 ~/.config/opencode/opencode.json）。令牌从运行 OpenCode 的进程环境变量 ${variable} 读取，保持 oauth=false。`,
  }[client];
  const prompt = `请帮我把野弦音乐服务器接入 ${mcpClients[client]}，使用 Streamable HTTP MCP 和 Bearer 工具凭据。
连接名称：${name}
MCP 地址：${url}

${instructions}

请先检查现有配置，保留其他 MCP 和用户设置；合并下方连接定义，不要覆盖整个文件。同名且配置不同则先展示差异，让我决定替换或改名。
令牌不在这段提示词里。请让我通过本机安全输入或配置界面提供，勿要求贴到聊天、打印令牌、写入启动参数或提交到 Git。不要把占位符当作真实凭据；GUI 启动的应用可能不会继承 shell 环境，请确认目标进程能读取环境变量。
配置后初始化 MCP、列出可用工具，再在授权范围内执行一次只读曲库查询（例如 library.search_tracks）；若没有这个工具则选择实际列出的只读工具。不修改曲库、不创建草案、不批准操作。
请报告实际连通性、工具返回结果及仍需的手动步骤或重启。仅保存配置不代表接入成功；无法执行验证时明确说明。不要关闭 TLS 校验，不自动改换线路或转发令牌。
${parsed.protocol === 'http:' ? '我已在网页允许此 HTTP 地址；它本身不提供 TLS 加密，不要推断 SD-WAN 一定已加密。\n' : ''}
${config ? `配置片段：\n\`\`\`${client === 'codex' ? 'toml' : 'json'}\n${config}\n\`\`\`` : '通用提示词未附带客户端专属配置；请按上述地址与认证方式生成目标客户端的配置。'}`;
  return { config, prompt, instructions, variable };
}
