(function init() {
  const url = location.href;
  const domain = location.hostname;

  // Envia meta (título)
  chrome.runtime.sendMessage({
    type: "PAGE_META",
    url,
    domain,
    title: document.title || "",
  });

  // Detecta busca por URL
  const found = detectSearchQuery(url);
  if (found) {
    chrome.runtime.sendMessage({
      type: "SEARCH_QUERY",
      engine: found.engine,
      query: found.query,
      url,
      domain,
    });
  }
})();
