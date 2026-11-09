import { HelpText } from './desktop-help';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useTranslation } from 'react-i18next';

export const providerNames: Record<string, string> = {
  musicbrainz: 'MusicBrainz',
  lastfm: 'Last.fm',
  caa: 'Cover Art Archive',
  acoustid: 'AcoustID',
  ai: 'providerDiagnostics.providerAi',
  telegram: 'Telegram',
  fpcalc: 'providerDiagnostics.providerFpcalc',
};
const reasons: Record<string, string> = {
  reachable: 'providerDiagnostics.reasonReachable',
  image_download_failed: 'providerDiagnostics.reasonImageDownloadFailed',
  image_decode_failed: 'providerDiagnostics.reasonImageDecodeFailed',
  credentials_invalid: 'providerDiagnostics.reasonCredentialsInvalid',
  rate_limited: 'providerDiagnostics.reasonRateLimited',
  unverified: 'providerDiagnostics.reasonUnverified',
  tls_eof: 'providerDiagnostics.reasonTlsEof',
  tls_error: 'providerDiagnostics.reasonTlsError',
  timeout: 'providerDiagnostics.reasonTimeout',
  dns_error: 'providerDiagnostics.reasonDnsError',
  connection_refused: 'providerDiagnostics.reasonConnectionRefused',
  connection_reset: 'providerDiagnostics.reasonConnectionReset',
  network_unavailable: 'providerDiagnostics.reasonNetworkUnavailable',
  provider_unavailable: 'providerDiagnostics.reasonProviderUnavailable',
  proxy_auth_required: 'providerDiagnostics.reasonProxyAuthRequired',
  proxy_not_configured: 'providerDiagnostics.reasonProxyNotConfigured',
  proxy_protocol_unsupported: 'providerDiagnostics.reasonProxyProtocolUnsupported',
  provider_http_error: 'providerDiagnostics.reasonProviderHttpError',
  provider_not_found: 'providerDiagnostics.reasonProviderNotFound',
  provider_invalid_response: 'providerDiagnostics.reasonProviderInvalidResponse',
  provider_response_too_large: 'providerDiagnostics.reasonProviderResponseTooLarge',
  lastfm_not_configured: 'providerDiagnostics.reasonLastfmNotConfigured',
  lastfm_track_not_found: 'providerDiagnostics.reasonLastfmTrackNotFound',
  acoustid_not_configured: 'providerDiagnostics.reasonAcoustidNotConfigured',
  lastfm_reauthorize: 'providerDiagnostics.reasonLastfmReauthorize',
  lastfm_invalid_session: 'providerDiagnostics.reasonLastfmInvalidSession',
  lastfm_invalid_response: 'providerDiagnostics.reasonLastfmInvalidResponse',
  musicbrainz_invalid_response: 'providerDiagnostics.reasonMusicbrainzInvalidResponse',
  acoustid_invalid_response: 'providerDiagnostics.reasonAcoustidInvalidResponse',
  acoustid_rejected: 'providerDiagnostics.reasonAcoustidRejected',
  acoustid_error_4: 'providerDiagnostics.reasonAcoustidError4',
  fingerprint_source_unavailable: 'providerDiagnostics.reasonFingerprintSourceUnavailable',
  fingerprint_source_changed: 'providerDiagnostics.reasonFingerprintSourceChanged',
  fingerprint_tool_missing: 'providerDiagnostics.reasonFingerprintToolMissing',
  fingerprint_platform_unsupported: 'providerDiagnostics.reasonFingerprintPlatformUnsupported',
  fingerprint_timeout: 'providerDiagnostics.reasonFingerprintTimeout',
  fingerprint_failed: 'providerDiagnostics.reasonFingerprintFailed',
  fingerprint_invalid_output: 'providerDiagnostics.reasonFingerprintInvalidOutput',
  invalid_cover: 'providerDiagnostics.reasonInvalidCover',
  unsafe_cover_redirect: 'providerDiagnostics.reasonUnsafeCoverRedirect',
  track_not_found: 'providerDiagnostics.reasonTrackNotFound',
  worker_stopped: 'providerDiagnostics.reasonWorkerStopped',
  refresh_target_removed: 'providerDiagnostics.reasonRefreshTargetRemoved',
  lastfm_error_6: 'providerDiagnostics.reasonLastfmError6',
  lastfm_error_10: 'providerDiagnostics.reasonLastfmError10',
  lastfm_error_13: 'providerDiagnostics.reasonLastfmError13',
  lastfm_error_14: 'providerDiagnostics.reasonLastfmError14',
  lastfm_error_15: 'providerDiagnostics.reasonLastfmError15',
  lastfm_error_26: 'providerDiagnostics.reasonLastfmError26',
  lastfm_error_29: 'providerDiagnostics.reasonLastfmError29',
};
export function providerReason(code: unknown, httpStatus?: number): string {
  if (code === 'provider_http_error') {
    if (httpStatus === 407) return reasons.proxy_auth_required;
    if (httpStatus === 429) return 'providerDiagnostics.reasonTooManyRequests';
    if (httpStatus === 401 || httpStatus === 403) return 'providerDiagnostics.reasonAccessDenied';
    if (httpStatus && httpStatus >= 500) return 'providerDiagnostics.reasonTemporarilyUnavailable';
  }
  if (typeof code !== 'string') return 'providerDiagnostics.reasonTaskIncomplete';
  if (reasons[code]) return reasons[code];
  if (/^lastfm_error_\d+$/.test(code)) return 'providerDiagnostics.reasonLastfmErrorUnmatched';
  if (/^acoustid_error_\d+$/.test(code)) return 'providerDiagnostics.reasonAcoustidErrorUnmatched';
  return reasons[code] || 'providerDiagnostics.reasonUnknownError';
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
  queued: 'providerDiagnostics.jobQueued',
  running: 'providerDiagnostics.jobRunning',
  completed: 'providerDiagnostics.jobCompleted',
  failed: 'providerDiagnostics.jobFailed',
  no_match: 'providerDiagnostics.jobNoMatch',
  stale: 'providerDiagnostics.jobStale',
};
export function JobDiagnostics({ job }: { job: ProviderJob }) {
  const { t } = useTranslation();
  const messages = jobReasons(job);
  return messages.length ? (
    <ul className="provider-reasons">
      {messages.map((message) => (
        <li key={message}>{t(message)}</li>
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
  const { t } = useTranslation();
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
            ? t('providerDiagnostics.networkTestTimeout')
            : reason instanceof Error
              ? reason.message
              : t('providerDiagnostics.networkTestIncomplete'),
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
    <section
      className="provider-network-test"
      aria-label={t('providerDiagnostics.networkTestAria')}
    >
      <div className="provider-network-heading">
        <h3>{t('providerDiagnostics.networkTestTitle')}</h3>
        <button disabled={disabled || busy} onClick={() => void testNetwork()}>
          {busy
            ? t('providerDiagnostics.testingNetwork')
            : error
              ? t('providerDiagnostics.retestNetwork')
              : t('providerDiagnostics.testNetwork')}
        </button>
      </div>
      <p className="muted">{t('providerDiagnostics.networkTestHint')}</p>
      {busy && <p role="status">{t('providerDiagnostics.testingProviders')}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {(value || busy) && tested !== draft && (
        <p role="status">{t('providerDiagnostics.draftChanged')}</p>
      )}
      {value && (
        <>
          <p className="muted">
            {t('providerDiagnostics.proxyModeLabel')}
            {value.proxy_mode === 'custom'
              ? t('providerDiagnostics.proxyCustom')
              : value.proxy_mode === 'direct'
                ? t('providerDiagnostics.proxyDirect')
                : t('providerDiagnostics.proxyEnvironment')}
            {t('providerDiagnostics.proxyModePeriod')}
          </p>
          <ul className="provider-network-results">
            {value.items.map((item) => (
              <li key={item.provider} className={`network-${item.status}`}>
                <div>
                  <strong>
                    <HelpText hint="networkCheck">
                      {t(providerNames[item.provider] || 'providerDiagnostics.unknownProvider')}
                    </HelpText>
                  </strong>
                  <span>
                    {item.status === 'ok'
                      ? t('providerDiagnostics.statusOk')
                      : item.status === 'unconfigured'
                        ? t('providerDiagnostics.statusUnconfigured')
                        : t('providerDiagnostics.statusError')}{' '}
                    · {Math.max(0, Math.round(item.elapsed_ms))} ms ·{' '}
                    {item.status === 'unconfigured'
                      ? t('providerDiagnostics.notRequested')
                      : item.via_proxy
                        ? t('providerDiagnostics.viaProxy')
                        : t('providerDiagnostics.direct')}
                    {item.http_status ? ` · HTTP ${item.http_status}` : ''}
                  </span>
                </div>
                <p>{t(providerReason(item.code, item.http_status))}</p>
                {item.checks && (
                  <ul className="network-checks">
                    {item.checks.map((check, index) => (
                      <li key={index}>
                        <strong>
                          {(
                            {
                              api: t('providerDiagnostics.checkApi'),
                              credentials: t('providerDiagnostics.checkCredentials'),
                              image_download: t('providerDiagnostics.checkImageDownload'),
                              image_decode: t('providerDiagnostics.checkImageDecode'),
                              image_download_decode: t(
                                'providerDiagnostics.checkImageDownloadDecode',
                              ),
                              local_fingerprint: t('providerDiagnostics.checkLocalFingerprint'),
                              personal_authorization: t(
                                'providerDiagnostics.checkPersonalAuthorization',
                              ),
                              text: t('providerDiagnostics.checkText'),
                              structured: t('providerDiagnostics.checkStructured'),
                              tools: t('providerDiagnostics.checkTools'),
                            } as Record<string, string>
                          )[check.name] || check.name}
                        </strong>
                        <span>
                          {check.status === 'ok'
                            ? t('providerDiagnostics.checkVerified')
                            : check.status === 'unverified'
                              ? t('providerDiagnostics.checkNotTested')
                              : t('providerDiagnostics.checkFailed')}{' '}
                          ·{' '}
                          {check.name === 'local_fingerprint'
                            ? t('providerDiagnostics.serverLocal')
                            : check.domain}
                          {Number.isFinite(check.elapsed_ms)
                            ? ` · ${Math.max(0, Math.round(check.elapsed_ms!))} ms`
                            : ''}
                          {check.http_status ? ` · HTTP ${check.http_status}` : ''}
                        </span>
                        <small>
                          {check.name === 'local_fingerprint'
                            ? t('providerDiagnostics.fingerprintScopeNote')
                            : (
                                {
                                  functional_api: t('providerDiagnostics.scopeFunctionalApi'),
                                  cover_download: t('providerDiagnostics.scopeCoverDownload'),
                                  personal_account: t('providerDiagnostics.scopePersonalAccount'),
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
