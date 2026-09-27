function quotaScore(acc = {}) {
  const gWeekly = acc.geminiWeekly?.pct ?? acc.quotas?.pro ?? 100;
  const g5h = acc.gemini5h?.pct ?? 100;
  const cWeekly = acc.claudeWeekly?.pct ?? acc.quotas?.claude ?? 100;
  const c5h = acc.claude5h?.pct ?? 100;
  const tierBonus = acc.subscriptionTier === 'PRO' ? 10 : 0;
  return (gWeekly * 0.45) + (g5h * 0.3) + (cWeekly * 0.15) + (c5h * 0.1) + tierBonus;
}

function isSessionAccount(account, activeSessionId, activeSessionEmail) {
  if (activeSessionId && account.id === activeSessionId) return true;
  if (activeSessionEmail && account.email && account.email.toLowerCase() === activeSessionEmail) return true;
  return false;
}

export function orderAccountCandidates(accounts, statsAccounts = {}, options = {}) {
  const activeSessionId = options.activeSessionId || null;
  const activeSessionEmail = (options.activeSessionEmail || '').trim().toLowerCase();
  const isCoolingDown = options.isCoolingDown || (() => false);

  const valid = accounts.filter((account) => {
    const accStats = statsAccounts[account.id];
    if (account.enabled === false || accStats?.enabled === false) return false;
    return !accStats || !accStats.is403Banned;
  });

  const available = [];
  const cooling = [];
  for (const account of valid) {
    if (isCoolingDown(account.id)) cooling.push(account);
    else available.push(account);
  }

  const byScore = (a, b) => quotaScore(statsAccounts[b.id]) - quotaScore(statsAccounts[a.id]);
  const session = available.find((account) => isSessionAccount(account, activeSessionId, activeSessionEmail));
  const rest = available.filter((account) => account !== session).sort(byScore);
  cooling.sort(byScore);

  if (session) return [session, ...rest, ...cooling];
  return [...available.sort(byScore), ...cooling];
}

export function shouldAdoptActiveSession(globalStats, servedAccount) {
  if (!servedAccount) return false;
  if (globalStats?.manualActiveAccountId) return false;
  const activeId = globalStats?.activeSessionAccountId || null;
  const activeEmail = (globalStats?.activeSessionEmail || '').trim().toLowerCase();
  if (!activeId && !activeEmail) return false;
  if (activeId && servedAccount.id === activeId) return false;
  if (activeEmail && servedAccount.email && servedAccount.email.toLowerCase() === activeEmail) return false;
  return true;
}

export function accountHeadroom(accStats = {}) {
  return {
    weekly: accStats?.geminiWeekly?.pct ?? accStats?.quotas?.pro ?? 100,
    burst: accStats?.gemini5h?.pct ?? 100
  };
}

const HOUR = 3600 * 1000;

/** Remaining quota and reset times of one model family ('gemini' | 'claude') on an account. */
export function familyBuckets(accStats = {}, family = 'gemini') {
  const claude = family === 'claude';
  const weeklyBucket = claude ? accStats?.claudeWeekly : accStats?.geminiWeekly;
  const burstBucket = claude ? accStats?.claude5h : accStats?.gemini5h;
  const fallbackWeekly = claude ? accStats?.quotas?.claude : accStats?.quotas?.pro;
  const time = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
  return {
    weekly: weeklyBucket?.pct ?? fallbackWeekly ?? 100,
    burst: burstBucket?.pct ?? 100,
    weeklyResetAt: time(weeklyBucket?.resetTime),
    burstResetAt: time(burstBucket?.resetTime)
  };
}

/**
 * "Use it or lose it": weekly quota left over at the weekly reset is wasted, so an account
 * whose weekly quota resets soon should be spent first. Urgency = % left per hour until reset.
 */
export function spendUrgency(buckets, now = Date.now()) {
  const hours = buckets.weeklyResetAt ? Math.max(6, (buckets.weeklyResetAt - now) / HOUR) : 168;
  return (buckets.weekly / hours) * (0.5 + 0.5 * (buckets.burst / 100));
}

/**
 * Smart Shield decision. Pure: no I/O, easy to test.
 * Returns { action: 'none' | 'wait' | 'stranded' | 'switch', reason, ... }.
 */
export function planShieldSwitch({
  accounts = [],
  statsAccounts = {},
  currentId,
  threshold = 20,
  weeklyThreshold,
  burstThreshold,
  families = ['gemini'],
  isCoolingDown = () => false,
  forceLow = false,
  resetGraceMs = 15 * 60 * 1000,
  primaryId = null,
  manualActiveId = null,
  isManualActive = false,
  now = Date.now()
} = {}) {
  const current = accounts.find((a) => a.id === currentId);
  if (!current) return { action: 'none', reason: 'current account unknown' };
  const weeklyT = weeklyThreshold ?? threshold;
  const burstT = burstThreshold ?? threshold;
  const watched = families.length ? families : ['gemini'];
  const main = watched[0];

  const cur = familyBuckets(statsAccounts[current.id], main);
  const base = { current, currentWeekly: cur.weekly, currentBurst: cur.burst, families: watched, weeklyThreshold: weeklyT, burstThreshold: burstT };

  // Which limits of the current account are low?
  const low = [];
  for (const family of watched) {
    const b = familyBuckets(statsAccounts[current.id], family);
    if (b.weekly < weeklyT) low.push({ family, bucket: 'weekly', pct: b.weekly, resetAt: b.weeklyResetAt });
    if (b.burst < burstT) low.push({ family, bucket: '5h', pct: b.burst, resetAt: b.burstResetAt });
  }

  // A replacement must have clearly more room than the thresholds, or we would bounce straight back.
  const minWeekly = Math.max(25, weeklyT + 5);
  const minBurst = Math.max(15, burstT + 5);
  const eligible = (account, weeklyMin = minWeekly, burstMin = minBurst) => {
    const s = statsAccounts[account.id];
    if (!s || !s.enabled || s.is403Banned || isCoolingDown(account.id)) return null;
    const per = watched.map((family) => familyBuckets(s, family));
    if (!per.every((b) => b.weekly > weeklyMin && b.burst > burstMin)) return null;
    return per[0];
  };
  const candidates = [];
  for (const account of accounts) {
    if (account.id === current.id) continue;
    const b = eligible(account);
    if (b) candidates.push({ account, weekly: b.weekly, burst: b.burst, weeklyResetAt: b.weeklyResetAt, score: spendUrgency(b, now) });
  }
  candidates.sort((a, b) => b.score - a.score);

  // Your main account comes first once it has recovered (after its reset).
  const primary = primaryId && primaryId !== current.id ? accounts.find((a) => a.id === primaryId) : null;
  const primaryReady = primary ? eligible(primary, weeklyT + 10, Math.max(50, burstT + 10)) : null;
  const primaryCandidate = primaryReady
    ? { account: primary, weekly: primaryReady.weekly, burst: primaryReady.burst, weeklyResetAt: primaryReady.weeklyResetAt, score: Infinity }
    : null;

  const isManuallySelected = isManualActive || (manualActiveId && current.id === manualActiveId);
  if (low.length === 0 && !forceLow) {
    if (primaryCandidate && !isManuallySelected) {
      return { action: 'switch', reason: 'return_to_main', target: primaryCandidate, candidates: [primaryCandidate, ...candidates], low, ...base };
    }
    return { action: 'none', reason: 'current account above thresholds', low, ...base };
  }

  // Not worth a restart if every low limit resets within the grace period and is not empty yet.
  if (!forceLow && resetGraceMs > 0 && low.every((l) => l.resetAt && l.resetAt - now <= resetGraceMs && l.pct > 1)) {
    const soonest = Math.max(...low.map((l) => l.resetAt));
    return { action: 'wait', reason: `low limits reset within ${Math.ceil((soonest - now) / 60000)} min`, resetAt: soonest, low, ...base };
  }

  const ordered = primaryCandidate ? [primaryCandidate, ...candidates] : candidates;
  if (ordered.length === 0) {
    return { action: 'stranded', reason: `no other account has more than ${minWeekly}% weekly and ${minBurst}% 5h left`, low, minWeekly, minBurst, ...base };
  }
  return { action: 'switch', reason: forceLow ? 'quota_error' : 'threshold', target: ordered[0], candidates: ordered, low, ...base };
}
