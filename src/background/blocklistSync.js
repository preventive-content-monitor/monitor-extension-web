import { S3_BLACKLIST_URL } from "../shared/constants.js";

const S3_CACHE_KEY = "s3BlocklistData";
// formato: { blacklist: string[], blacklistETag: string }
//
// NOTA: a whitelist foi removida deste módulo.
// Motivos:
//  1. Causa bug: removia bloqueios explícitos do responsável se o site estava na whitelist S3
//  2. Cresce indefinidamente (todo site safe = nova entrada)
//  3. A extensão não precisa dela para o DNR — a blacklist já contém só conteúdo score >= 70
//  A whitelist existe apenas no DB do backend (cache de classificação e /api/blocklist/verificar)

async function fetchList(url, storedETag) {
    if (!url) return { data: null, etag: storedETag };
    try {
        const headers = {};
        if (storedETag) headers["If-None-Match"] = storedETag;

        const resp = await fetch(url, { headers });

        if (resp.status === 304) {
            // Not Modified — S3 confirmou que nada mudou (zero bytes transferidos)
            return { data: null, etag: storedETag };
        }
        if (!resp.ok) {
            console.warn("[Guardian] S3 retornou status", resp.status, "para", url);
            return { data: null, etag: storedETag };
        }

        const data = await resp.json();
        const etag = resp.headers.get("ETag") || "";
        return { data, etag };
    } catch (e) {
        console.warn("[Guardian] Blocklist fetch error:", url, e.message);
        return { data: null, etag: storedETag };
    }
}

/**
 * Busca blackList.json via S3 publico com suporte a ETag (304 Not Modified).
 *
 * O S3 retorna ETag automaticamente; o header If-None-Match evita transferir
 * o arquivo inteiro quando nao ha mudancas (zero bytes transferidos no 304).
 *
 * CloudFront foi removido: role voclabs do AWS Academy nao permite
 * cloudfront:CreateDistribution. A extensao Chrome acessa o S3 regional direto.
 *
 * Chame no onInstalled, onStartup e pelo s3RefreshTimer (60s).
 */
export async function refreshS3Blocklist() {
    const stored =
        (await chrome.storage.local.get(S3_CACHE_KEY))[S3_CACHE_KEY] || {};

    const blackResult = await fetchList(S3_BLACKLIST_URL, stored.blacklistETag || "");

    const updated = { ...stored };

    if (blackResult.data !== null) {
        updated.blacklist = blackResult.data;
        updated.blacklistETag = blackResult.etag;
    }

    if (!Array.isArray(updated.blacklist)) updated.blacklist = [];

    await chrome.storage.local.set({ [S3_CACHE_KEY]: updated });

    console.log(
        `[Guardian] Blocklist atualizada via S3: ${updated.blacklist.length} bloqueados`
    );

    return updated;
}

/** Retorna a blacklist do cache local (sem fetch — zero latência). */
export async function getS3Blacklist() {
    const stored =
        (await chrome.storage.local.get(S3_CACHE_KEY))[S3_CACHE_KEY] || {};
    return Array.isArray(stored.blacklist) ? stored.blacklist : [];
}
