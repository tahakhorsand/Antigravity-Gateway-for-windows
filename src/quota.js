import { getValidAccessToken } from './auth.js';

const LOAD_CODE_ASSIST_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
];

const QUOTA_SUMMARY_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
];

const AVAILABLE_MODELS_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
];

const USER_AGENT = 'antigravity/4.3.0 darwin/arm64';

export function formatResetTime(isoString) {
  if (!isoString) return 'Active';
  const target = new Date(isoString).getTime();
  const now = Date.now();
  const diffMs = target - now;

  if (diffMs <= 0) return 'Reset ready';

  const diffMins = Math.floor(diffMs / (1000 * 60));
  const days = Math.floor(diffMins / (60 * 24));
  const hours = Math.floor((diffMins % (60 * 24)) / 60);
  const mins = diffMins % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

async function requestWithFallback(endpoints, token, body = {}) {
  let lastError = null;
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000) // a hanging endpoint must not stall Smart Shield
      });

      if (res.status === 403) {
        return { status: 403, error: 'Forbidden' };
      }

      if (res.status === 401) {
        return { status: 401, error: 'Unauthorized' };
      }

      if (res.ok) {
        const data = await res.json();
        return { status: 200, data };
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
  }
  return { status: 500, error: lastError?.message || 'Failed all endpoints' };
}

export async function fetchLiveAccountQuota(account, forceRefresh = false) {
  try {
    let token = await getValidAccessToken(account, forceRefresh);

    // 1. Subscription Tier
    let subscriptionTier = 'FREE';
    let tierRes = await requestWithFallback(LOAD_CODE_ASSIST_ENDPOINTS, token, {
      metadata: { ideType: 'ANTIGRAVITY' }
    });

    // If 401 Unauthorized, token might have been revoked or invalidated; retry once with force refresh
    if (tierRes.status === 401) {
      token = await getValidAccessToken(account, true);
      tierRes = await requestWithFallback(LOAD_CODE_ASSIST_ENDPOINTS, token, {
        metadata: { ideType: 'ANTIGRAVITY' }
      });
    }

    if (tierRes.status === 403) {
      return { is403: true, error: 'Account restricted or 403 Forbidden' };
    }

    if (tierRes.status === 200 && tierRes.data) {
      const paid = tierRes.data.paidTier?.id || tierRes.data.paidTier?.name;
      const curr = tierRes.data.currentTier?.id || tierRes.data.currentTier?.name;
      if (paid && (paid.includes('pro') || paid.includes('ultra'))) {
        subscriptionTier = 'PRO';
      } else if (curr && (curr.includes('pro') || curr.includes('ultra'))) {
        subscriptionTier = 'PRO';
      } else {
        subscriptionTier = 'STANDARD';
      }
    }

    // 2. Quota Summary (Weekly + 5h Buckets)
    let summaryRes = await requestWithFallback(QUOTA_SUMMARY_ENDPOINTS, token);
    if (summaryRes.status === 401) {
      token = await getValidAccessToken(account, true);
      summaryRes = await requestWithFallback(QUOTA_SUMMARY_ENDPOINTS, token);
    }

    let geminiWeekly = { pct: 100, resetTime: null, resetText: 'Active', desc: '' };
    let gemini5h = { pct: 100, resetTime: null, resetText: 'Active', desc: '' };
    let claudeWeekly = { pct: 100, resetTime: null, resetText: 'Active', desc: '' };
    let claude5h = { pct: 100, resetTime: null, resetText: 'Active', desc: '' };

    if (summaryRes.status === 200 && summaryRes.data?.groups) {
      for (const group of summaryRes.data.groups) {
        const name = (group.displayName || '').toLowerCase();
        const isGemini = name.includes('gemini');
        const isClaude = name.includes('claude') || name.includes('gpt') || name.includes('3p');

        for (const bucket of group.buckets || []) {
          const pct = Math.round((bucket.remainingFraction ?? 1.0) * 1000) / 10;
          const resetTime = bucket.resetTime || null;
          const resetText = resetTime ? formatResetTime(resetTime) : 'Active';
          const desc = bucket.description || '';

          if (isGemini) {
            if (bucket.window === 'weekly') {
              geminiWeekly = { pct, resetTime, resetText, desc };
            } else if (bucket.window === '5h') {
              gemini5h = { pct, resetTime, resetText, desc };
            }
          } else if (isClaude) {
            if (bucket.window === 'weekly') {
              claudeWeekly = { pct, resetTime, resetText, desc };
            } else if (bucket.window === '5h') {
              claude5h = { pct, resetTime, resetText, desc };
            }
          }
        }
      }
    }

    // 3. Models Quota
    const modelsRes = await requestWithFallback(AVAILABLE_MODELS_ENDPOINTS, token);
    let proPct = geminiWeekly.pct;
    let flashPct = geminiWeekly.pct;
    let claudePct = claudeWeekly.pct;
    let imagenPct = 100;

    if (modelsRes.status === 200 && modelsRes.data?.models) {
      const models = modelsRes.data.models;
      
      const proModel = models['gemini-2.5-pro'] || models['gemini-3.1-pro-high'] || models['gemini-pro-agent'];
      if (proModel?.quotaInfo?.remainingFraction !== undefined) {
        proPct = Math.round(proModel.quotaInfo.remainingFraction * 1000) / 10;
      }

      const flashModel = models['gemini-3.8-flash-medium'] || models['gemini-3.8-flash-high'] || models['gemini-3.7-flash-medium'] || models['gemini-2.5-flash'] || models['gemini-3.5-flash-lite'] || models['gemini-3-flash'];
      if (flashModel?.quotaInfo?.remainingFraction !== undefined) {
        flashPct = Math.round(flashModel.quotaInfo.remainingFraction * 1000) / 10;
      }

      const claudeModel = models['claude-sonnet-4-6'] || models['claude-opus-4-6-thinking'];
      if (claudeModel?.quotaInfo?.remainingFraction !== undefined) {
        claudePct = Math.round(claudeModel.quotaInfo.remainingFraction * 1000) / 10;
      }

      const imageModel = models['gemini-3.1-flash-image'];
      if (imageModel?.quotaInfo?.remainingFraction !== undefined) {
        imagenPct = Math.round(imageModel.quotaInfo.remainingFraction * 1000) / 10;
      }
    }

    return {
      is403: false,
      subscriptionTier,
      lastSynced: new Date().toISOString(),
      geminiWeekly,
      gemini5h,
      claudeWeekly,
      claude5h,
      quotas: {
        pro: proPct,
        flash: flashPct,
        claude: claudePct,
        imagen: imagenPct
      }
    };
  } catch (err) {
    return {
      is403: false,
      error: err.message,
      lastSynced: new Date().toISOString()
    };
  }
}
