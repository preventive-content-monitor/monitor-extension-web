// eslint-disable-next-line no-unused-vars
function detectSearchQuery(locationHref) {
  try {
    const u = new URL(locationHref);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();

    const engines = [
      { host: "google.com", param: "q", name: "google" },
      { host: "bing.com", param: "q", name: "bing" },
      { host: "duckduckgo.com", param: "q", name: "duckduckgo" },
    ];

    const engine = engines.find(
      (e) => host === e.host || host.endsWith("." + e.host),
    );
    if (!engine) return null;

    const q = u.searchParams.get(engine.param);
    if (!q || q.trim().length < 2) return null;

    return { engine: engine.name, query: q.trim() };
  } catch {
    return null;
  }
}
