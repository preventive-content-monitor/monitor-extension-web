export async function getSettings() {
  return await chrome.storage.sync.get(null);
}

export function normalizeDomain(hostname = "") {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

export function isDomainBlocked(hostname, blocklistDomains) {
  const domain = normalizeDomain(hostname);
  return (blocklistDomains || []).some(
    (d) =>
      domain === normalizeDomain(d) ||
      domain.endsWith("." + normalizeDomain(d)),
  );
}

export function containsBlockedKeyword(text, keywordBlocklist) {
  const t = (text || "").toLowerCase();
  return (keywordBlocklist || []).some(
    (kw) => kw && t.includes(kw.toLowerCase()),
  );
}
