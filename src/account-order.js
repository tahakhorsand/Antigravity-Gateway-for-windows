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

/**
 * Smart Shield decision. Pure: no I/O, easy to test.
 * Returns { action: 'none' | 'stranded' | 'switch', ... }.
 */
export function planShieldSwitch({
  accounts = [],
  statsAccounts = {},
  currentId,
  threshold = 20,
  isCoolingDown = () => false,
  forceLow = false
} = {}) {
  const current = accounts.find((a) => a.id === currentId);
  if (!current) return { action: 'none', reason: 'current account unknown' };

  const cur = accountHeadroom(statsAccounts[current.id]);
  const low = forceLow || cur.weekly < threshold || cur.burst < threshold;
  if (!low) {
    return { action: 'none', reason: 'current account above threshold', current, currentWeekly: cur.weekly, currentBurst: cur.burst };
  }

  // A replacement must have clearly more room than the threshold, or we would bounce straight back.
  const minWeekly = Math.max(25, threshold + 5);
  const minBurst = Math.max(15, threshold + 5);
  const candidates = [];
  for (const account of accounts) {
    if (account.id === current.id) continue;
    const s = statsAccounts[account.id];
    if (!s || !s.enabled || s.is403Banned || isCoolingDown(account.id)) continue;
    const h = accountHeadroom(s);
    if (h.weekly > minWeekly && h.burst > minBurst) {
      candidates.push({ account, weekly: h.weekly, burst: h.burst, score: h.weekly * 0.6 + h.burst * 0.4 });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const base = { current, currentWeekly: cur.weekly, currentBurst: cur.burst, minWeekly, minBurst };
  if (candidates.length === 0) {
    return { action: 'stranded', reason: `no other account has more than ${minWeekly}% weekly and ${minBurst}% 5h quota left`, ...base };
  }
  return { action: 'switch', target: candidates[0], candidates, ...base };
}
