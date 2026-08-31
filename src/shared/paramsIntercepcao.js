/**
 * Leitura dos parâmetros das páginas de intercepção (blocked / warn / educate).
 *
 * O DNR monta a URL destino com o parâmetro `url` POR ÚLTIMO e com a URL
 * original crua, sem escapar. Se essa URL tiver query string
 * (ex: youtube.com/watch?v=abc&t=30), um URLSearchParams cortaria no primeiro
 * "&" e devolveria a URL truncada — e o "continuar assim mesmo" levaria ao
 * lugar errado.
 *
 * Por isso `url` é lida como "tudo que vem depois de url=".
 */
export function lerParametrosIntercepcao(search = window.location.search) {
  const query = search.startsWith("?") ? search.slice(1) : search;

  // Tudo após o primeiro "url=" é a URL original, inclusive & e =
  let url = "";
  const marcador = query.indexOf("url=");
  if (marcador >= 0) {
    const bruto = query.slice(marcador + 4);
    try {
      url = decodeURIComponent(bruto);
    } catch {
      // URL com % inválido — usa como veio
      url = bruto;
    }
  }

  // Os demais parâmetros vêm antes de "url=" e são seguros para o parser padrão
  const anteriores = new URLSearchParams(
    marcador >= 0 ? query.slice(0, marcador) : query,
  );

  const domain =
    anteriores.get("domain") ||
    (() => {
      try {
        return new URL(url).hostname.replace(/^www\./i, "");
      } catch {
        return "";
      }
    })();

  return {
    url,
    domain,
    mode: anteriores.get("mode") || "blacklist",
  };
}
