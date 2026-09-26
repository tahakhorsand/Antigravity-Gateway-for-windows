export function knownAccountRecord(activeEmail, poolEmails = []) {
  const emails = [];
  const seen = new Set();
  for (const email of poolEmails) {
    const value = (email || '').trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    emails.push(value);
  }

  const active = (activeEmail || '').trim() || emails[0] || '';
  const activeKey = active.toLowerCase();
  return {
    active,
    old: emails.filter((email) => email.toLowerCase() !== activeKey)
  };
}

export function mergeAccount(existing, incoming) {
  if (!existing) return { ...incoming };
  return {
    ...existing,
    ...incoming,
    id: existing.id || incoming.id,
    project_id: incoming.project_id || existing.project_id,
    id_token: incoming.id_token || existing.id_token
  };
}
