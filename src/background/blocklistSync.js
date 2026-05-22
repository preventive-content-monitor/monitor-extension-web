import { S3_BLACKLIST_URL, S3_WHITELIST_URL } from "../shared/constants.js";

const S3_CACHE_KEY = "s3BlocklistData";
// formato: { blacklist: string[], whitelist: string[], blacklistETag: string, whitelistETag: string }

async function fetchList(url, storedETag) {
    if (!url) return { data: null, etag: storedETag };
    try {
        const headers = {};
        if (storedETag) headers["If-None-Match"] = storedETag;

        const resp = await fetch(url, { headers });

        if (resp.status === 304) {
            // Not Modified — usa cache
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
        console.warn("[Guardian] S3 fetch error:", url, e.message);
        return { data: null, etag: storedETag };
    }
}

/**
 * Busca whiteList.json e blackList.json do S3 com suporte a ETag (304 Not Modified).
 * Armazena resultado em chrome.storage.local para uso offline.
 * Chame isso no onInstalled, onStartup e periodicamente.
 */
export async function refreshS3Blocklist() {
    const stored =
        (await chrome.storage.local.get(S3_CACHE_KEY))[S3_CACHE_KEY] || {};

    const [blackResult, whiteResult] = await Promise.all([
        fetchList(S3_BLACKLIST_URL, stored.blacklistETag || ""),
        fetchList(S3_WHITELIST_URL, stored.whitelistETag || ""),
    ]);

    const updated = { ...stored };

    if (blackResult.data !== null) {
        updated.blacklist = blackResult.data;
        updated.blacklistETag = blackResult.etag;
    }
    if (whiteResult.data !== null) {
        updated.whitelist = whiteResult.data;
        updated.whitelistETag = whiteResult.etag;
    }

    if (!Array.isArray(updated.blacklist)) updated.blacklist = [];
    if (!Array.isArray(updated.whitelist)) updated.whitelist = [];

    await chrome.storage.local.set({ [S3_CACHE_KEY]: updated });

    console.log(
        `[Guardian] S3 blocklist atualizado: ${updated.blacklist.length} bloqueados, ${updated.whitelist.length} permitidos`,
    );

    return updated;
}

/** Retorna a blacklist do S3 (do cache local, sem fetch). */
export async function getS3Blacklist() {
    const stored =
        (await chrome.storage.local.get(S3_CACHE_KEY))[S3_CACHE_KEY] || {};
    return Array.isArray(stored.blacklist) ? stored.blacklist : [];
}

/** Retorna a whitelist do S3 (do cache local, sem fetch). */
export async function getS3Whitelist() {
    const stored =
        (await chrome.storage.local.get(S3_CACHE_KEY))[S3_CACHE_KEY] || {};
    return Array.isArray(stored.whitelist) ? stored.whitelist : [];
}
