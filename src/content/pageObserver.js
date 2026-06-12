// Plataformas mistas — mesmo conjunto do backend (ServicoBlocklistS3.PLATAFORMAS_MISTAS)
const PLATAFORMAS_MISTAS = new Set([
  "youtube.com", "www.youtube.com", "youtu.be",
  "twitch.tv", "www.twitch.tv",
  "reddit.com", "www.reddit.com",
  "tiktok.com", "www.tiktok.com",
]);

function ehPlataformaMista(hostname) {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  return PLATAFORMAS_MISTAS.has(hostname.toLowerCase()) ||
         PLATAFORMAS_MISTAS.has("www." + h);
}

/**
 * Extrai metadados adicionais da página para enriquecer a classificação da IA.
 * Captura: descrição (meta tags), restrição etária, e dados do ytInitialData.
 */
function extrairContextoPagina() {
  const ctx = {};

  // Meta description (OpenGraph ou padrão)
  const desc =
    document.querySelector('meta[property="og:description"]')?.content ||
    document.querySelector('meta[name="description"]')?.content ||
    "";
  if (desc) ctx.descricao = desc.slice(0, 300);

  // Restrição etária do YouTube (elemento visível na página)
  const ageRestrict =
    document.querySelector('[class*="age-gate"]') ||
    document.querySelector('[id*="age-gate"]') ||
    document.querySelector('tp-yt-paper-dialog') ||
    document.body?.innerHTML?.includes("conteúdo adulto") ||
    document.body?.innerHTML?.includes("content is age-restricted");
  if (ageRestrict) ctx.restricaoEtaria = true;

  // Tenta extrair dados do ytInitialData (disponível no escopo da página)
  try {
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      if (s.textContent.includes("ytInitialData")) {
        const match = s.textContent.match(/ytInitialData\s*=\s*(\{.+?\});/s);
        if (match) {
          const data = JSON.parse(match[1]);
          // Categoria do vídeo
          const cat = data?.contents?.twoColumnWatchNextResults
            ?.results?.results?.contents?.[1]
            ?.videoSecondaryInfoRenderer?.metadataRowContainer
            ?.metadataRowContainerRenderer?.rows;
          if (cat) {
            const catRow = cat.find(r => r?.metadataRowRenderer?.title?.simpleText === "Categoria");
            if (catRow) ctx.categoria = catRow.metadataRowRenderer?.contents?.[0]?.runs?.[0]?.text;
          }
          break;
        }
      }
    }
  } catch {}

  return ctx;
}

function ehPaginaDeConteudo(hostname, url) {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  if (h === "youtube.com") return url.includes("/watch?");
  if (h === "youtu.be")   return true;
  if (h === "twitch.tv")  return /twitch\.tv\/\w+\/clip|twitch\.tv\/videos\//.test(url);
  if (h === "tiktok.com") return url.includes("/video/");
  return false;
}

(function init() {
  const url    = location.href;
  const domain = location.hostname;

  // Envia meta inicial (título pode ainda ser genérico em SPAs)
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

  // Para plataformas mistas em páginas de conteúdo específico,
  // aguarda o título real do vídeo/conteúdo carregar via MutationObserver.
  // Quando o título muda do genérico ("YouTube") para o real ("Nome do vídeo - YouTube"),
  // envia PAGE_META_UPDATED para o service worker classificar imediatamente.
  if (ehPlataformaMista(domain) && ehPaginaDeConteudo(domain, url)) {
    let ultimoTitulo = document.title;
    let enviado = false;

    const observer = new MutationObserver(() => {
      const novoTitulo = document.title;
      // Usa sempre a URL atual (location.href) — pode ter mudado por SPA navigation
      const urlAtual = location.href;

      // Ignora enquanto título for genérico (sem conteúdo real)
      const tituloPuro = novoTitulo
        .replace(/\s*[-–|]\s*(YouTube|Twitch|TikTok|Reddit)\s*$/i, "")
        .trim();
      if (!tituloPuro || novoTitulo === ultimoTitulo) return;

      ultimoTitulo = novoTitulo;

      chrome.runtime.sendMessage({
        type: "PAGE_META_UPDATED",
        url: urlAtual,
        domain: location.hostname,
        title: novoTitulo,
      });

      // Só classifica sincronamente uma vez por título
      if (!enviado) {
        enviado = true;
        const ctx = extrairContextoPagina();
        chrome.runtime.sendMessage({
          type: "CLASSIFICAR_AGORA",
          url: urlAtual,
          domain: location.hostname,
          title: novoTitulo,
          descricao: ctx.descricao || "",
          restricaoEtaria: ctx.restricaoEtaria || false,
          categoria: ctx.categoria || "",
        });
      }
    });

    // Observa mudanças no <title>
    const titleEl = document.querySelector("title");
    if (titleEl) {
      observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }

    // Fallback: após 3s, envia o que tiver com contexto capturado
    setTimeout(() => {
      if (!enviado && document.title && document.title !== ultimoTitulo) {
        enviado = true;
        const ctx = extrairContextoPagina();
        chrome.runtime.sendMessage({
          type: "CLASSIFICAR_AGORA",
          url,
          domain,
          title: document.title,
          descricao: ctx.descricao || "",
          restricaoEtaria: ctx.restricaoEtaria || false,
          categoria: ctx.categoria || "",
        });
      }
    }, 3000);
  }
})();
