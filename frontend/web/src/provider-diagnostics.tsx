import { HelpText } from './desktop-help';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export const providerNames: Record<string, string> = {
  musicbrainz: 'MusicBrainz',
  lastfm: 'Last.fm',
  caa: 'Cover Art Archive',
  acoustid: 'AcoustID',
  ai: '当前 AI 连接',
  telegram: 'Telegram',
  fpcalc: '本机指纹工具',
};
const reasons: Record<string, string> = {
  reachable: '服务可连接。',
  image_download_failed: '封面 API 可访问，但图片下载未完成。',
  image_decode_failed: '图片已下载，但无法解码为有效封面。',
  credentials_invalid: '远端已响应，但凭据未通过验证。',
  rate_limited: '远端正在限流，请稍后重试。',
  unverified: '本次未验证此能力。',
  tls_eof: 'TLS 连接提前断开，请检查代理出口或尝试直接连接。',
  tls_error: 'TLS 连接或证书校验失败，请检查代理与服务端证书环境。',
  timeout: '连接超时，请检查代理出口或网络后重试。',
  dns_error: '服务端无法解析目标域名，请检查 DNS 或代理。',
  connection_refused: '连接被拒绝，请检查代理地址和端口是否可用。',
  connection_reset: '连接被远端中断，请检查代理出口或稍后重试。',
  network_unavailable: '服务端网络不可用，请检查网络或代理。',
  provider_unavailable: '无法连接资料来源，请在联网设置中检测网络和代理。',
  proxy_auth_required: '代理要求认证，请检查代理用户名和密码。',
  proxy_not_configured: '手动代理地址尚未配置，请填写地址或改用直接连接。',
  proxy_protocol_unsupported: '代理协议不受支持，请使用 http:// 开头的 HTTP 代理地址。',
  provider_http_error: '资料来源返回 HTTP 错误，请检查网络、代理或服务状态。',
  provider_not_found: '资料来源没有找到对应内容。',
  provider_invalid_response: '来源返回了无法识别的响应，可能是代理错误页或接口暂时异常。',
  provider_response_too_large: '来源响应过大，已停止读取，请稍后重试。',
  lastfm_not_configured: '尚未保存 Last.fm API 密钥。',
  lastfm_track_not_found: 'Last.fm 未找到对应歌曲，请核对歌名与艺人或尝试其他来源。',
  acoustid_not_configured: '尚未保存 AcoustID API Key。',
  lastfm_reauthorize: 'Last.fm 授权已失效，请重新连接账号。',
  lastfm_invalid_session: 'Last.fm 会话已失效，请重新连接账号。',
  lastfm_invalid_response: 'Last.fm 返回的资料格式无效，请稍后重试。',
  musicbrainz_invalid_response: 'MusicBrainz 返回的资料格式无效，请稍后重试。',
  acoustid_invalid_response: 'AcoustID 返回的识别结果无效，请稍后重试。',
  acoustid_rejected: 'AcoustID 拒绝识别请求，请检查已保存的应用 API Key。',
  acoustid_error_4:
    'AcoustID 应用密钥无效。请填写 Application API Key；账号页的 User API Key 不能用于识别。',
  fingerprint_source_unavailable: '无法读取音频，未能计算指纹，请检查托管曲库。',
  fingerprint_source_changed: '音频文件已变化，请重新扫描后更新资料。',
  fingerprint_tool_missing: '服务端缺少 Chromaprint 指纹工具，请更新镜像或安装工具。',
  fingerprint_platform_unsupported: '当前服务端系统不支持本机指纹计算，可使用 Docker 镜像。',
  fingerprint_timeout: '音频指纹计算超时，可稍后重试。',
  fingerprint_failed: '音频指纹计算失败，请检查音频文件是否可读取。',
  fingerprint_invalid_output: '指纹工具未返回有效结果，请检查音频或更新工具。',
  invalid_cover: '封面文件无效或不符合图片要求，请尝试其他候选。',
  unsafe_cover_redirect: '封面来源跳转到不支持的地址，已停止获取。',
  track_not_found: '歌曲已经不可用，请刷新曲库。',
  worker_stopped: '服务重启或任务被中断，请重新更新资料。',
  refresh_target_removed: '任务或歌曲已被移除，本批保留了原记录，请刷新曲库。',
  lastfm_error_6: 'Last.fm 未找到对应歌曲，或不接受当前查询参数，请核对歌名和艺人。',
  lastfm_error_10: 'Last.fm API Key 无效，请核对已保存的应用密钥。',
  lastfm_error_13: 'Last.fm 签名校验失败，请核对已保存的 API Secret。',
  lastfm_error_14: '尚未在 Last.fm 完成授权，请重新发起连接。',
  lastfm_error_15: 'Last.fm 授权令牌已过期，请重新发起连接。',
  lastfm_error_26: 'Last.fm 应用密钥已被停用，请检查应用状态。',
  lastfm_error_29: 'Last.fm 请求过于频繁，请稍后重试。',
};
export function providerReason(code: unknown, httpStatus?: number): string {
  if (code === 'provider_http_error') {
    if (httpStatus === 407) return reasons.proxy_auth_required;
    if (httpStatus === 429) return '来源请求过于频繁，请稍后重试。';
    if (httpStatus === 401 || httpStatus === 403) return '来源拒绝访问，请核对 API 配置和代理。';
    if (httpStatus && httpStatus >= 500) return '资料来源或代理服务暂时异常，请稍后重试。';
  }
  if (typeof code !== 'string') return '任务未能完成，请检测网络或稍后重试。';
  if (reasons[code]) return reasons[code];
  if (/^lastfm_error_\d+$/.test(code))
    return 'Last.fm 拒绝请求，请核对已保存的 API 设置或服务状态。';
  if (/^acoustid_error_\d+$/.test(code))
    return 'AcoustID 拒绝请求，请核对已保存的应用 API Key 或服务状态。';
  return reasons[code] || '来源返回了未识别的错误，请检测网络或稍后重试。';
}
export interface ProviderJob {
  id: string;
  track_id?: string;
  title?: string;
  status: string;
  error?: string | null;
  warnings?: string;
}
export function jobReasons(job: Pick<ProviderJob, 'error' | 'warnings'>): string[] {
  const codes: unknown[] = job.error ? [job.error] : [];
  if (job.warnings) {
    try {
      const warnings = JSON.parse(job.warnings);
      if (Array.isArray(warnings)) codes.push(...warnings);
    } catch {
      codes.push('unknown');
    }
  }
  return [...new Set(codes.map((code) => providerReason(code)))];
}
export const jobStatus: Record<string, string> = {
  queued: '排队中',
  running: '查询中',
  completed: '建议已生成',
  failed: '查询失败',
  no_match: '没有新增资料',
  stale: '歌曲已修改，请重新更新',
};
export function JobDiagnostics({ job }: { job: ProviderJob }) {
  const messages = jobReasons(job);
  return messages.length ? (
    <ul className="provider-reasons">
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  ) : null;
}

type ProxyMode = 'environment' | 'custom' | 'direct';
interface NetworkResult {
  proxy_mode: ProxyMode;
  items: {
    provider: string;
    status: 'ok' | 'error' | 'unconfigured';
    elapsed_ms: number;
    http_status?: number;
    code: string;
    via_proxy: boolean;
    checks?: {
      name: string;
      status: 'ok' | 'error' | 'unverified';
      code: string;
      elapsed_ms?: number;
      http_status?: number;
      domain: string;
      scope: string;
    }[];
  }[];
}
export function ProviderNetworkTest({
  mode,
  proxy,
  disabled = false,
}: {
  mode: ProxyMode;
  proxy: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<NetworkResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [tested, setTested] = useState('');
  const request = useRef<AbortController | null>(null),
    timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      const current = request.current;
      request.current = null;
      current?.abort();
      clearTimeout(timeout.current);
    },
    [],
  );
  const draft = JSON.stringify([mode, proxy]);
  async function testNetwork() {
    if (request.current || disabled) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setValue(null);
    setTested(draft);
    timeout.current = setTimeout(() => controller.abort(), 90000);
    try {
      const result = await api<NetworkResult>('/manage/providers/network-test', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ proxy_mode: mode, ...(proxy ? { proxy_url: proxy } : {}) }),
      });
      if (!controller.signal.aborted) setValue(result);
    } catch (reason) {
      if (request.current === controller)
        setError(
          controller.signal.aborted
            ? '网络检测超时，请重试或更换代理方式。'
            : reason instanceof Error
              ? reason.message
              : '网络检测未完成，请重试。',
        );
    } finally {
      clearTimeout(timeout.current);
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className="provider-network-test" aria-label="联网来源网络检测">
      <div className="provider-network-heading">
        <h3>网络检测</h3>
        <button disabled={disabled || busy} onClick={() => void testNetwork()}>
          {busy ? '正在检测网络…' : error ? '重新检测网络' : '检测网络'}
        </button>
      </div>
      <p className="muted">
        使用点击时的代理草稿与已保存的 API
        密钥，不保存当前设置。检测从服务端发出；连接成功不代表一定有这首歌的资料。
      </p>
      {busy && <p role="status">正在逐个检测资料来源，请稍候…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {(value || busy) && tested !== draft && (
        <p role="status">代理草稿已变化，请按当前设置重新检测。</p>
      )}
      {value && (
        <>
          <p className="muted">
            本次代理方式：
            {value.proxy_mode === 'custom'
              ? '手动指定'
              : value.proxy_mode === 'direct'
                ? '直接连接'
                : '跟随环境变量'}
            。
          </p>
          <ul className="provider-network-results">
            {value.items.map((item) => (
              <li key={item.provider} className={`network-${item.status}`}>
                <div>
                  <strong>
                    <HelpText hint="networkCheck">
                      {providerNames[item.provider] || '资料来源'}
                    </HelpText>
                  </strong>
                  <span>
                    {item.status === 'ok'
                      ? '可连接'
                      : item.status === 'unconfigured'
                        ? '未配置'
                        : '连接失败'}{' '}
                    · {Math.max(0, Math.round(item.elapsed_ms))} ms ·{' '}
                    {item.status === 'unconfigured'
                      ? '未发起请求'
                      : item.via_proxy
                        ? '经代理'
                        : '直连'}
                    {item.http_status ? ` · HTTP ${item.http_status}` : ''}
                  </span>
                </div>
                <p>{providerReason(item.code, item.http_status)}</p>
                {item.checks && (
                  <ul className="network-checks">
                    {item.checks.map((check, index) => (
                      <li key={index}>
                        <strong>
                          {(
                            {
                              api: 'API 响应',
                              credentials: '凭据验证',
                              image_download: '图片下载',
                              image_decode: '图片解码',
                              image_download_decode: '图片下载与解码',
                              local_fingerprint: '本机音频指纹计算',
                              personal_authorization: '个人账号授权',
                              text: '文本响应',
                              structured: '结构化选歌',
                              tools: '工具调用',
                            } as Record<string, string>
                          )[check.name] || check.name}
                        </strong>
                        <span>
                          {check.status === 'ok'
                            ? '已验证'
                            : check.status === 'unverified'
                              ? '本次未测试'
                              : '失败'}{' '}
                          · {check.name === 'local_fingerprint' ? '服务端本机' : check.domain}
                          {Number.isFinite(check.elapsed_ms)
                            ? ` · ${Math.max(0, Math.round(check.elapsed_ms!))} ms`
                            : ''}
                          {check.http_status ? ` · HTTP ${check.http_status}` : ''}
                        </span>
                        <small>
                          {check.name === 'local_fingerprint'
                            ? '本次网络检测未读取音频、未计算指纹；识别时由本机生成，无需额外密钥。'
                            : (
                                {
                                  functional_api: '来源 API',
                                  cover_download: '封面下载',
                                  personal_account: '个人账号',
                                } as Record<string, string>
                              )[check.scope] || check.scope}
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
