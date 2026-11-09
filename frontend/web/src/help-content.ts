import i18n from './i18n';

/** Short, contextual explanations. Keep names, errors and consequences visible in the page. */
export const hints = {
  get searchService(): string {
    return i18n.t('helpContent.searchService');
  },
  get modelConnection(): string {
    return i18n.t('helpContent.modelConnection');
  },
  get lyricOffset(): string {
    return i18n.t('helpContent.lyricOffset');
  },
  get downloadSuffix(): string {
    return i18n.t('helpContent.downloadSuffix');
  },
  get telegramQuiet(): string {
    return i18n.t('helpContent.telegramQuiet');
  },
  get telegramTarget(): string {
    return i18n.t('helpContent.telegramTarget');
  },
  get hostAllowlist(): string {
    return i18n.t('helpContent.hostAllowlist');
  },
  get sourcePriority(): string {
    return i18n.t('helpContent.sourcePriority');
  },
  get pluginUrl(): string {
    return i18n.t('helpContent.pluginUrl');
  },
  get savedSecret(): string {
    return i18n.t('helpContent.savedSecret');
  },
  get pluginEnabled(): string {
    return i18n.t('helpContent.pluginEnabled');
  },
  get pluginMaintenance(): string {
    return i18n.t('helpContent.pluginMaintenance');
  },
  get acoustid(): string {
    return i18n.t('helpContent.acoustid');
  },
  get proxy(): string {
    return i18n.t('helpContent.proxy');
  },
  get publicUrl(): string {
    return i18n.t('helpContent.publicUrl');
  },
  get providerPriority(): string {
    return i18n.t('helpContent.providerPriority');
  },
  get networkCheck(): string {
    return i18n.t('helpContent.networkCheck');
  },
  get fingerprint(): string {
    return i18n.t('helpContent.fingerprint');
  },
  get aiProtocol(): string {
    return i18n.t('helpContent.aiProtocol');
  },
  get aiProvider(): string {
    return i18n.t('helpContent.aiProvider');
  },
  get reasoning(): string {
    return i18n.t('helpContent.reasoning');
  },
  get outputTokens(): string {
    return i18n.t('helpContent.outputTokens');
  },
  get aiTimeout(): string {
    return i18n.t('helpContent.aiTimeout');
  },
  get aiBudget(): string {
    return i18n.t('helpContent.aiBudget');
  },
  get backgroundAI(): string {
    return i18n.t('helpContent.backgroundAI');
  },
  get aiStream(): string {
    return i18n.t('helpContent.aiStream');
  },
  get nativeSearch(): string {
    return i18n.t('helpContent.nativeSearch');
  },
  get searchBudget(): string {
    return i18n.t('helpContent.searchBudget');
  },
  get summary(): string {
    return i18n.t('helpContent.summary');
  },
  get memory(): string {
    return i18n.t('helpContent.memory');
  },
  get history(): string {
    return i18n.t('helpContent.history');
  },
  get application(): string {
    return i18n.t('helpContent.application');
  },
  get mcpScopes(): string {
    return i18n.t('helpContent.mcpScopes');
  },
  get replayGain(): string {
    return i18n.t('helpContent.replayGain');
  },
  get gainPreamp(): string {
    return i18n.t('helpContent.gainPreamp');
  },
  get clipping(): string {
    return i18n.t('helpContent.clipping');
  },
  get albumGain(): string {
    return i18n.t('helpContent.albumGain');
  },
  get trackGain(): string {
    return i18n.t('helpContent.trackGain');
  },
  get gainResult(): string {
    return i18n.t('helpContent.gainResult');
  },
  get scanMode(): string {
    return i18n.t('helpContent.scanMode');
  },
  get lyricGoal(): string {
    return i18n.t('helpContent.lyricGoal');
  },
  get lyricPreference(): string {
    return i18n.t('helpContent.lyricPreference');
  },
  get scanRate(): string {
    return i18n.t('helpContent.scanRate');
  },
  get scanForce(): string {
    return i18n.t('helpContent.scanForce');
  },
  get lyricReady(): string {
    return i18n.t('helpContent.lyricReady');
  },
  get lyricSkipped(): string {
    return i18n.t('helpContent.lyricSkipped');
  },
  get lyricNoMatch(): string {
    return i18n.t('helpContent.lyricNoMatch');
  },
  get candidate(): string {
    return i18n.t('helpContent.candidate');
  },
  get metadataVersion(): string {
    return i18n.t('helpContent.metadataVersion');
  },
  get manualValue(): string {
    return i18n.t('helpContent.manualValue');
  },
  get reviewSkip(): string {
    return i18n.t('helpContent.reviewSkip');
  },
  get reviewReject(): string {
    return i18n.t('helpContent.reviewReject');
  },
  get reviewAccept(): string {
    return i18n.t('helpContent.reviewAccept');
  },
  get stale(): string {
    return i18n.t('helpContent.stale');
  },
  get taskHistory(): string {
    return i18n.t('helpContent.taskHistory');
  },
  get diagnostic(): string {
    return i18n.t('helpContent.diagnostic');
  },
  get importStable(): string {
    return i18n.t('helpContent.importStable');
  },
  get importInterval(): string {
    return i18n.t('helpContent.importInterval');
  },
  get fullScan(): string {
    return i18n.t('helpContent.fullScan');
  },
  get offlineLimit(): string {
    return i18n.t('helpContent.offlineLimit');
  },
  get offlineQuality(): string {
    return i18n.t('helpContent.offlineQuality');
  },
  get cacheDays(): string {
    return i18n.t('helpContent.cacheDays');
  },
  get cacheSize(): string {
    return i18n.t('helpContent.cacheSize');
  },
  get transcodeJobs(): string {
    return i18n.t('helpContent.transcodeJobs');
  },
  get playbackQuality(): string {
    return i18n.t('helpContent.playbackQuality');
  },
  get handoff(): string {
    return i18n.t('helpContent.handoff');
  },
  get recommendations(): string {
    return i18n.t('helpContent.recommendations');
  },
  get listenCount(): string {
    return i18n.t('helpContent.listenCount');
  },
  get sorting(): string {
    return i18n.t('helpContent.sorting');
  },
};
export type HelpKey = keyof typeof hints;

export const importCounterHelp: Record<string, string> = {
  get visited() {
    return i18n.t('helpContent.counter_visited');
  },
  get added() {
    return i18n.t('helpContent.counter_added');
  },
  get updated() {
    return i18n.t('helpContent.counter_updated');
  },
  get unchanged() {
    return i18n.t('helpContent.counter_unchanged');
  },
  get errors() {
    return i18n.t('helpContent.counter_errors');
  },
  get missing() {
    return i18n.t('helpContent.counter_missing');
  },
  get skipped() {
    return i18n.t('helpContent.counter_skipped');
  },
  get copied() {
    return i18n.t('helpContent.counter_copied');
  },
  get duplicates() {
    return i18n.t('helpContent.counter_duplicates');
  },
  get assets_copied() {
    return i18n.t('helpContent.counter_assets_copied');
  },
  get conflicts() {
    return i18n.t('helpContent.counter_conflicts');
  },
  get review() {
    return i18n.t('helpContent.counter_review');
  },
  get waiting() {
    return i18n.t('helpContent.counter_waiting');
  },
  get converted() {
    return i18n.t('helpContent.counter_converted');
  },
};

export const stateHelp: Record<string, string> = {
  get stale() {
    return hints.stale;
  },
  get approved() {
    return i18n.t('helpContent.state_approved');
  },
  get applied() {
    return i18n.t('helpContent.state_applied');
  },
  get partial() {
    return i18n.t('helpContent.state_partial');
  },
  get partial_success() {
    return i18n.t('helpContent.state_partial_success');
  },
  get paused_budget() {
    return i18n.t('helpContent.state_paused_budget');
  },
  get paused_auth() {
    return i18n.t('helpContent.state_paused_auth');
  },
  get paused_authorization() {
    return i18n.t('helpContent.state_paused_authorization');
  },
  get retry_wait() {
    return i18n.t('helpContent.state_retry_wait');
  },
  get sent() {
    return i18n.t('helpContent.state_sent');
  },
  get unknown() {
    return i18n.t('helpContent.state_unknown');
  },
  get unverified() {
    return i18n.t('helpContent.state_unverified');
  },
  get unsupported() {
    return i18n.t('helpContent.state_unsupported');
  },
};
