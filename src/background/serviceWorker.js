import {
  ensureDefaults,
  isEnrolled,
  enrollWithCode,
  clearEnrollment,
  getEnrollmentInfo,
  generateDeviceName,
  ensureComputerId,
} from "./deviceIdentity.js";
import { getSettings } from "./policyStore.js";
import { enqueueEvent, readQueue, acknowledgeEvents } from "./eventQueue.js";
import {
  postEventsBatch,
  fetchPolicy,
  authenticatedDeviceFetch,
  loginUser,
  logoutUser,
  authorizeExistingDevice,
  registerUser,
  getKeywordStatus,
  setKeyword,
} from "./apiClient.js";
import { EVENT_TYPES, API_BASE_URL } from "../shared/constants.js";
import {
  syncBlocklistToDNR,
  adicionarBypassDNR,
  limparBypassDNR,
  INTERCEPTA_CONTEUDO,
} from "./dnrRules.js";
import { syncPolicy, invalidatePolicyCache } from "./policySync.js";
import { refreshS3Blocklist, getS3Blacklist } from "./blocklistSync.js";

let uploadTimer = null;
let uploadPromise = null;
let policySyncTimer = null;
let s3RefreshTimer = null;

// Domínios que o usuário optou por continuar acessando na sessão atual (WARN/EDUCATE bypass)
const warnBypassSet = new Set();

// ================== PROTEÇÃO CONTRA BURLA ==================
const HEARTBEAT_ALARM = "guardian-heartbeat";
const POLICY_ALARM = "guardian-policy-sync";
const SETTINGS_LOCK_ALARM = "guardian-settings-lock";
const UNLOCK_MS = 5 * 60 * 1000;
const tabsBeingProtected = new Set();

async function _baseUrl() {
  const s = await getSettings();
  return s.backendUrl || API_BASE_URL;
}

async function _protecaoPost(path, body) {
  const resp = await authenticatedDeviceFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }, await _baseUrl());
  if (!resp.ok) {
    const payload = await resp.json().catch(() => null);
    throw new Error(payload?.mensagem || "Não foi possível falar com o servidor do GuardIAn.");
  }
  return await resp.json();
}

/** A aba anônima está protegida se a extensão tem acesso a ela ou se o arquivo de proteção a desativou. */
async function _anonimoProtegido() {
  if (await chrome.extension.isAllowedIncognitoAccess().catch(() => false)) return true;
  const { anonimoBloqueado } = await chrome.storage.managed.get(["anonimoBloqueado"]).catch(() => ({}));
  return anonimoBloqueado === true || anonimoBloqueado === 1;
}

/** Sinal de vida: informa o servidor e arma a URL que denuncia a remoção da extensão. */
async function enviarSinalDeVida() {
  if (!(await isEnrolled())) {
    await chrome.runtime.setUninstallURL("").catch(() => {});
    return;
  }
  try {
    const anonimoPermitido = await _anonimoProtegido();
    const data = await _protecaoPost("/api/protecao/sinal", {
      versao: chrome.runtime.getManifest().version,
      anonimoPermitido,
    });
    const { deviceId } = await chrome.storage.local.get(["deviceId"]);
    if (data?.tokenRemocao && deviceId) {
      const url = `${await _baseUrl()}/api/protecao/removida?d=${encodeURIComponent(deviceId)}&t=${encodeURIComponent(data.tokenRemocao)}`;
      await chrome.runtime.setUninstallURL(url);
    }
    await chrome.storage.local.set({
      palavraChaveDefinida: !!data?.palavraChaveDefinida,
      anonimoPermitido,
      ultimoSinal: Date.now(),
    });
  } catch (e) {
    console.warn("[Guardian] Sinal de vida falhou:", e.message);
  }
}

function agendarSinalDeVida() {
  chrome.alarms.create(HEARTBEAT_ALARM, { delayInMinutes: 0.1, periodInMinutes: 5 });
  // O setInterval morre quando o Chrome adormece o service worker; o alarme o acorda.
  chrome.alarms.create(POLICY_ALARM, { periodInMinutes: 0.5 });
}

async function _sincronizarEAplicarPolitica() {
  const policy = await syncPolicy();
  if (!policy) return null;
  const s3Blocked = await getS3Blacklist();
  const allBlocked = [...new Set([...(policy.blockedDomains || []), ...s3Blocked])];
  await _redirectOpenBlockedTabs(allBlocked, policy.mode || "BLOCK");
  return policy;
}

function _checarAba(tabId, url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  try {
    _verificarEBloquearUrl(url, new URL(url).hostname, tabId);
  } catch {}
}

// Pega navegações que o DNR não vê (página servida do cache/service worker do site, voltar/avançar).
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) _checarAba(d.tabId, d.url);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((t) => _checarAba(tabId, t.url)).catch(() => {});
});

/** O instalador atualiza os arquivos da pasta; se a versão no disco mudou, recarrega a extensão. */
async function _recarregarSeAtualizada() {
  try {
    const resp = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    const versaoNoDisco = (await resp.json())?.version;
    if (versaoNoDisco && versaoNoDisco !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch (error) {
    console.warn("[Guardian] Não foi possível verificar atualização:", error?.message || error);
  }
}
_recarregarSeAtualizada();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    _recarregarSeAtualizada();
    enviarSinalDeVida();
  }
  if (alarm.name === POLICY_ALARM) {
    _sincronizarEAplicarPolitica().catch((e) => console.warn("[Guardian] Policy alarm falhou:", e?.message || e));
  }
  if (alarm.name === SETTINGS_LOCK_ALARM) {
    chrome.storage.session.remove(["unlockedUntil"])
      .then(_protegerAbasAbertas)
      .catch((error) => console.warn("[Guardian] Não foi possível bloquear novamente as configurações:", error?.message || error));
  }
});

async function _estaDesbloqueado() {
  const { unlockedUntil } = await chrome.storage.session.get(["unlockedUntil"]);
  return !!unlockedUntil && unlockedUntil > Date.now();
}

function _paginaDeGerenciamento(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!["chrome:", "edge:"].includes(parsed.protocol.toLowerCase())) return null;
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase().replace(/\/+$/, "");
    if (host === "extensions") return "extensions";
    if (host === "settings" && (path === "/reset" || path.startsWith("/reset/"))) return "reset";
  } catch (error) {
    console.warn("[Guardian] Não foi possível verificar uma página do navegador:", error?.message || error);
  }
  return null;
}

async function _protegerAbaDoNavegador(tab) {
  if (!tab?.id || tabsBeingProtected.has(tab.id)) return;
  tabsBeingProtected.add(tab.id);
  try {
    if (!(await isEnrolled()) || await _estaDesbloqueado()) return;

    if (tab.incognito && !tab.url?.startsWith(chrome.runtime.getURL(""))) {
      await chrome.tabs.remove(tab.id);
      return;
    }

    const reason = _paginaDeGerenciamento(tab.url);
    if (!reason) return;
    const optionsUrl = `${chrome.runtime.getURL("src/options/options.html")}?protection=${reason}`;
    await chrome.tabs.update(tab.id, { url: optionsUrl });
  } catch (error) {
    console.warn("[Guardian] Não foi possível aplicar a proteção à aba:", error?.message || error);
  } finally {
    tabsBeingProtected.delete(tab.id);
  }
}

async function _protegerAbasAbertas() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(_protegerAbaDoNavegador));
  } catch (error) {
    console.warn("[Guardian] Não foi possível verificar as abas abertas:", error?.message || error);
  }
}

chrome.tabs.onCreated.addListener(_protegerAbaDoNavegador);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "managed" && changes.anonimoBloqueado) enviarSinalDeVida();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    _protegerAbaDoNavegador(tab);
  }
});

function _mensagemTentativa(resultado) {
  if (resultado?.bloqueadoAte) {
    const hora = new Date(resultado.bloqueadoAte).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    return `Muitas tentativas. Tente de novo às ${hora}. O responsável foi avisado.`;
  }
  const restantes = resultado?.tentativasRestantes;
  return restantes ? `Palavra-chave errada. Restam ${restantes} tentativa(s).` : "Palavra-chave errada.";
}

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    // Cada pacote publicado já sai com o endereço do servidor correto;
    // evita reaproveitar um backendUrl antigo salvo no storage sincronizado.
    if (details?.reason === "install" || details?.reason === "update") {
      await chrome.storage.sync.set({ backendUrl: API_BASE_URL });
      await chrome.storage.local.remove(["authToken", "authEmail", "authAt"]);
      await chrome.storage.session.remove(["linkToken", "authEmail", "authAt"]);
      await chrome.storage.session.remove(["unlockedUntil"]);
      await chrome.alarms.clear(SETTINGS_LOCK_ALARM);
    }
    await ensureDefaults();
    await refreshGuardianSiteTabs();

    // Se já está enrolled, garante que upload está habilitado
    const enrolled = await isEnrolled();
    if (enrolled) {
      await _protegerAbasAbertas();
      const s = await getSettings();
      if (!s.uploadEnabled) {
        console.log(
          "[Guardian] Habilitando upload para dispositivo já enrolled",
        );
        await chrome.storage.sync.set({
          uploadEnabled: true,
          backendUrl: s.backendUrl || API_BASE_URL,
        });
      }
    }

    // Bypasses de WARN/EDUCATE valem só pela sessão; regras do DNR sobrevivem
    // a reinícios, então precisam ser descartadas aqui.
    await limparBypassDNR().catch(() => {});

    // Baixa S3 blacklist ANTES de sincronizar política — syncPolicy usa getS3Blacklist() internamente
    await refreshS3Blocklist().catch((e) =>
      console.warn("[Guardian] S3 refresh falhou no install:", e.message),
    );

    // Sincroniza política do backend (já inclui S3 blacklist no DNR)
    const policy = await syncPolicy();

    // Se não conseguiu (não enrolled ou erro), usa local + S3
    if (!policy) {
      const s = await getSettings();
      const s3Blocked = await getS3Blacklist();
      await syncBlocklistToDNR(
        [...new Set([...(s.blocklistDomains || []), ...s3Blocked])],
        s.protectionEnabled !== false,
        s.allowlistDomains || [],
        _modoLocal(s),
      );
    }

    await startUploadLoop();
    await startPolicySyncLoop();
    agendarSinalDeVida();
  } catch (e) {
    console.error("onInstalled failed:", e);
  }
});

// Também sincroniza ao iniciar (depois de reboot do navegador)
chrome.runtime.onStartup.addListener(async () => {
  try {
    // Se já está enrolled, garante que upload está habilitado
    const enrolled = await isEnrolled();
    if (enrolled) {
      const s = await getSettings();
      if (!s.uploadEnabled) {
        console.log(
          "[Guardian] Habilitando upload para dispositivo já enrolled",
        );
        await chrome.storage.sync.set({
          uploadEnabled: true,
          backendUrl: s.backendUrl || API_BASE_URL,
        });
      }
    }

    // Bypasses de WARN/EDUCATE não sobrevivem ao reinício do navegador
    await limparBypassDNR().catch(() => {});

    // Baixa S3 blacklist ANTES de sincronizar política
    await refreshS3Blocklist().catch((e) =>
      console.warn("[Guardian] S3 refresh falhou no startup:", e.message),
    );

    await syncPolicy();

    await startUploadLoop();
    await startPolicySyncLoop();
    agendarSinalDeVida();
  } catch (e) {
    console.error("onStartup failed:", e);
  }
});

/**
 * Após atualizar o DNR, redireciona abas já abertas que estejam em domínios bloqueados.
 * Isso evita que o usuário precise dar F5 para ver o bloqueio.
 */
/**
 * Modo da política a partir das configurações locais.
 * Usado nos caminhos de fallback, quando o backend não respondeu — espelha
 * o buildLocalPolicy do policySync para o DNR não cair sempre em BLOCK.
 */
function _modoLocal(settings) {
  switch (settings?.actionOnHighRisk) {
    case "warn":
      return "WARN";
    case "educate":
      return "EDUCATE";
    default:
      return "BLOCK";
  }
}

async function _redirectOpenBlockedTabs(blockedDomains, mode) {
  if (!blockedDomains || blockedDomains.length === 0) return;
  // EDUCATE não interrompe a navegação em curso
  if (!INTERCEPTA_CONTEUDO(mode)) return;
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    const blockedPage  = chrome.runtime.getURL("src/blocked/blocked.html");
    const warnPage     = chrome.runtime.getURL("src/warned/warn.html");
    const policyMode   = mode || "BLOCK";

    for (const tab of tabs) {
      try {
        // Ignora abas já em páginas de ação do Guardian
        const u = tab.url || "";
        if (u.startsWith(blockedPage) || u.startsWith(warnPage)) continue;

        const host = new URL(u).hostname.replace(/^www\./i, "").toLowerCase();

        // Bypass de sessão (só vale no modo Avisar)
        if (policyMode === "WARN" && warnBypassSet.has(host)) continue;

        const match = blockedDomains.find(
          (d) => host === d || host.endsWith("." + d),
        );
        if (match) {
          // EDUCATE já retornou acima — aqui o modo é BLOCK ou WARN
          const targetPage =
            policyMode === "WARN"
              ? `${warnPage}?domain=${encodeURIComponent(host)}&url=${encodeURIComponent(u)}`
              : `${blockedPage}?domain=${encodeURIComponent(host)}&url=${encodeURIComponent(u)}`;
          console.log("[Guardian] Redirecionando aba aberta:", host, "→", policyMode);
          await chrome.tabs.update(tab.id, { url: targetPage });
        }
      } catch {
        // aba pode ter sido fechada ou ser chrome:// — ignora
      }
    }
  } catch (e) {
    console.warn("[Guardian] _redirectOpenBlockedTabs falhou:", e.message);
  }
}

async function startPolicySyncLoop() {
  if (policySyncTimer) clearInterval(policySyncTimer);
  if (s3RefreshTimer) clearInterval(s3RefreshTimer);

  // Sincroniza política a cada 5 segundos para pegar mudanças do dashboard
  policySyncTimer = setInterval(async () => {
    try {
      const policy = await syncPolicy();
      if (policy) {
        console.log(
          "[Guardian] Policy synced - allowed:",
          policy.allowedDomains?.length || 0,
          "blocked:",
          policy.blockedDomains?.length || 0,
        );
        // Redireciona abas já abertas que estejam em domínios bloqueados
        const s3Blocked = await getS3Blacklist();
        const allBlocked = [...new Set([...(policy.blockedDomains || []), ...s3Blocked])];
        await _redirectOpenBlockedTabs(allBlocked, policy.mode || "BLOCK");
      }
    } catch (e) {
      console.warn("[Guardian] Policy sync failed:", e.message);
    }
  }, 5 * 1000);

  // Atualiza S3 blacklist/whitelist a cada 60s com ETag (304 se não mudou — tráfego mínimo)
  s3RefreshTimer = setInterval(async () => {
    await refreshS3Blocklist().catch((e) =>
      console.warn("[Guardian] S3 refresh periódico falhou:", e.message)
    );
  }, 60 * 1000);
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;

  try {
    // Sincroniza política do backend (prioridade)
    const policy = await syncPolicy();

    // Se não conseguiu, usa local
    if (!policy) {
      const s = await getSettings();
      await syncBlocklistToDNR(
        s.blocklistDomains || [],
        s.protectionEnabled !== false,
        s.allowlistDomains || [],
        _modoLocal(s),
      );
    }

    // Se mudou backendUrl/uploadEnabled etc, reinicia loop
    await startUploadLoop();
  } catch (e) {
    console.error("onChanged failed:", e);
  }
});

async function uploadQueued(settings, max) {
  if (uploadPromise) return await uploadPromise;
  uploadPromise = (async () => {
    if (!settings.deviceId || !(await isEnrolled())) return;
    const batch = await readQueue(max);
    if (!batch.length) return;
    await postEventsBatch(settings.deviceId, batch, settings.backendUrl || API_BASE_URL);
    await acknowledgeEvents(batch.length);
  })().finally(() => { uploadPromise = null; });
  return await uploadPromise;
}

async function startUploadLoop() {
  const s = await getSettings();

  if (uploadTimer) clearInterval(uploadTimer);

  // Verifica se está enrolled e pode enviar
  const enrolled = await isEnrolled();
  const canUpload = enrolled && s.deviceId;

  if (!canUpload) {
    console.log("[Guardian] Upload desabilitado:", {
      enrolled,
      deviceId: !!s.deviceId,
    });
    return;
  }

  console.log(
    "[Guardian] Upload habilitado, iniciando loop para deviceId:",
    s.deviceId,
    "events api:",
    s.backendUrl || API_BASE_URL,
  );

  // Faz upload imediato se tiver eventos pendentes
  try {
    await uploadQueued(s, 200);
  } catch (e) {
    console.warn("[Guardian] Upload inicial falhou:", e?.message || e);
  }

  uploadTimer = setInterval(
    async () => {
      try {
        // Re-busca settings a cada iteração para pegar deviceId atualizado
        const currentSettings = await getSettings();

        if (!currentSettings.deviceId) {
          console.log("[Guardian] Upload ignorado - sem deviceId");
          return;
        }

        await uploadQueued(currentSettings, 200);
      } catch (e) {
        console.warn("[Guardian] Upload failed:", e?.message || e);
      }
    },
    (s.uploadIntervalSec || 10) * 1000,
  );
}

// Log de navegação (URL visitada)
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  try {
    const url = details.url || "";

    // Ignora URLs internas do navegador (edge://, chrome://, about:, etc.)
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;

    const u = new URL(url);

    // Apenas verifica bloqueio — o evento será enfileirado pelo PAGE_META
    // do content script (que inclui o título da página)
    await _verificarEBloquearUrl(url, u.hostname, details.tabId);
  } catch (e) {
    console.warn("webNavigation log failed:", e?.message || e);
  }
});

// Plataformas mistas com conteúdo específico por URL
const PLATAFORMAS_MISTAS_SW = new Set([
  "youtube.com", "www.youtube.com", "youtu.be",
  "twitch.tv", "www.twitch.tv",
  "reddit.com", "www.reddit.com",
  "tiktok.com", "www.tiktok.com",
]);

function _ehConteudoEspecifico(hostname, url) {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  if (h === "youtube.com") return url.includes("/watch?");
  if (h === "youtu.be")   return true;
  if (h === "twitch.tv")  return /twitch\.tv\/\w+\/(clip|videos)/.test(url);
  if (h === "tiktok.com") return url.includes("/video/");
  return false;
}

/**
 * Aguarda até o título da aba ser atualizado (diferente do anterior)
 * ou até o timeout, e retorna o título atual da aba.
 */
async function _aguardarTituloTab(tabId, tituloAnterior, tentativas = 6, intervaloMs = 500) {
  for (let i = 0; i < tentativas; i++) {
    await new Promise((r) => setTimeout(r, intervaloMs));
    try {
      const tab = await chrome.tabs.get(tabId);
      const titulo = tab.title || "";
      // Considera carregado quando o título mudou e não é genérico
      if (titulo && titulo !== tituloAnterior && !["YouTube", "Twitch", "TikTok", "Reddit"].includes(titulo.trim())) {
        return titulo;
      }
    } catch {
      break;
    }
  }
  // Retorna o que tiver após o timeout
  try { return (await chrome.tabs.get(tabId)).title || ""; } catch { return ""; }
}

// Detecta navegação dentro de SPAs (YouTube, etc.) que não recarregam a página
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  try {
    const url = details.url || "";

    // Ignora URLs internas do navegador (edge://, chrome://, about:, etc.)
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;

    const u = new URL(url);
    await _verificarEBloquearUrl(url, u.hostname, details.tabId);

    const s = await getSettings();

    // Para plataformas mistas com conteúdo específico (ex: youtube.com/watch?v=...)
    // aguarda o título real carregar e classifica via IA imediatamente
    const host = u.hostname.toLowerCase();
    if (PLATAFORMAS_MISTAS_SW.has(host) && _ehConteudoEspecifico(host, url) && s.deviceId) {
      // Pega título anterior para detectar mudança
      let tituloAnterior = "";
      try { tituloAnterior = (await chrome.tabs.get(details.tabId)).title || ""; } catch {}

      // Aguarda título real em background — não bloqueia o registro do evento
      (async () => {
        const titulo = await _aguardarTituloTab(details.tabId, tituloAnterior);
        if (!titulo) return;

        console.log("[Guardian] SPA título detectado:", titulo, "→ classificando...");

        // Enfileira evento com título real
        await enqueueEvent({
          type: EVENT_TYPES.NAVIGATION,
          ts: Date.now(),
          occurredAt: new Date().toISOString(),
          url,
          title: titulo,
          metadata: { domain: host, tabId: details.tabId, spa: true },
        });

        // Classifica via backend e bloqueia se necessário
        const baseUrl = s.backendUrl || API_BASE_URL;
        try {
          const resp = await authenticatedDeviceFetch("/api/blocklist/classificar-agora", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, titulo, dispositivoId: s.deviceId }),
          }, baseUrl);
          if (resp.ok) {
            const resultado = await resp.json();
            console.log("[Guardian] SPA classificação:", url, "→", resultado.acao, resultado.motivo);

            // EDUCATE não interfere: o evento já foi enfileirado acima e o
            // responsável verá o acesso nas Atividades e nos alertas.
            const acao = resultado.acao;
            if (acao === "BLOCK" || acao === "WARN") {
              const h2 = u.hostname.replace(/^www\./i, "").toLowerCase();
              const targetPage =
                acao === "WARN"
                  ? chrome.runtime.getURL(`src/warned/warn.html?domain=${encodeURIComponent(h2)}&url=${encodeURIComponent(url)}`)
                  : chrome.runtime.getURL(`src/blocked/blocked.html?domain=${encodeURIComponent(h2)}&url=${encodeURIComponent(url)}`);
              await chrome.tabs.update(details.tabId, { url: targetPage });
              console.log("[Guardian] SPA intercepção imediata:", url, "→", acao);
            } else if (acao === "EDUCATE") {
              console.log("[Guardian] SPA modo EDUCATE — apenas registrado:", url);
            }
          }
        } catch (e) {
          console.warn("[Guardian] SPA classificação falhou:", e?.message);
        }

        _uploadImediato(s);
      })();

      return; // evento será enfileirado dentro do bloco acima com o título correto
    }

    // Para plataformas mistas (ex: youtube.com homepage, search) que não são
    // páginas de conteúdo específico — só enfileira se não for plataforma mista.
    // Para plataformas mistas sem conteúdo específico, o PAGE_META do content script
    // registra o título correto quando disponível.
    if (!PLATAFORMAS_MISTAS_SW.has(host)) {
      await enqueueEvent({
        type: EVENT_TYPES.NAVIGATION,
        ts: Date.now(),
        occurredAt: new Date().toISOString(),
        url,
        title: "",
        metadata: { domain: u.hostname, tabId: details.tabId, spa: true },
      });
      _uploadImediato(s);
    }
  } catch (e) {
    console.warn("historyStateUpdated log failed:", e?.message || e);
  }
});

/**
 * Verifica se a URL está na blocklist local e redireciona conforme o modo de proteção.
 * BLOCK → blocked.html | WARN → warn.html (bypassável) | EDUCATE → não interfere
 * Funciona para SPAs e para páginas que o DNR ainda não interceptou.
 */
async function _verificarEBloquearUrl(url, hostname, tabId) {
  try {
    const { cachedPolicy } = await chrome.storage.local.get(["cachedPolicy"]);
    const policy = cachedPolicy?.policy;
    if (!policy?.blockedDomains?.length) return;

    const blocked = policy.blockedDomains;
    const urlLower = url.toLowerCase();
    const mode = policy.mode || "BLOCK";

    // EDUCATE apenas registra — o evento já foi enfileirado pelo chamador
    if (!INTERCEPTA_CONTEUDO(mode)) return;

    const h = hostname.replace(/^www\./i, "").toLowerCase();

    // Verifica bypass de sessão (usuário optou por continuar em WARN)
    if (mode === "WARN" && warnBypassSet.has(h)) return;

    const match = blocked.find((entry) => {
      if (entry.includes("/")) {
        return urlLower.includes(entry.toLowerCase());
      } else {
        const d = entry.replace(/^www\./i, "").toLowerCase();
        return h === d || h.endsWith("." + d);
      }
    });

    if (match) {
      // EDUCATE já retornou acima — aqui o modo é BLOCK ou WARN
      const targetPage =
        mode === "WARN"
          ? chrome.runtime.getURL(
              `src/warned/warn.html?domain=${encodeURIComponent(h)}&url=${encodeURIComponent(url)}`,
            )
          : chrome.runtime.getURL(
              `src/blocked/blocked.html?domain=${encodeURIComponent(h)}&url=${encodeURIComponent(url)}`,
            );
      console.log(`[Guardian] Intercepção ${mode}:`, url, "→", match);
      await chrome.tabs.update(tabId, { url: targetPage });
    }
  } catch (e) {
    // Não interrompe o fluxo normal em caso de erro
  }
}

/**
 * Envia eventos imediatamente, sem esperar o próximo tick do timer.
 */
async function _uploadImediato(s) {
  const enrolled = await isEnrolled();
  if (!enrolled || !s?.deviceId) return;
  try {
    await uploadQueued(s, 50);
  } catch (e) {
    console.warn("[Guardian] Upload imediato falhou:", e?.message || e);
  }
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

async function initializeEnrolledMonitoring() {
  try {
    await startUploadLoop();
    await startPolicySyncLoop();
    const enrolledPolicy = await syncPolicy();
    if (!enrolledPolicy || !enrolledPolicy.fromBackend) {
      throw new Error("Não foi possível obter a política do servidor.");
    }
    const s3Blocked = await getS3Blacklist();
    const allBlocked = [...new Set([...(enrolledPolicy.blockedDomains || []), ...s3Blocked])];
    await _redirectOpenBlockedTabs(allBlocked, enrolledPolicy.mode || "BLOCK");
    agendarSinalDeVida();
    await enviarSinalDeVida();
    return null;
  } catch (error) {
    console.error("[Guardian] Vínculo salvo, mas a proteção não foi sincronizada:", error);
    return "O vínculo foi salvo, mas a proteção não pôde ser sincronizada. Verifique a conexão e recarregue a extensão.";
  }
}

async function enrollThisBrowser(code, deviceName, token) {
  const s = await getSettings();
  const baseUrl = s.backendUrl || API_BASE_URL;
  const result = await enrollWithCode(
    code,
    deviceName || generateDeviceName(),
    baseUrl,
    token,
    await ensureComputerId(),
  );
  const warning = await initializeEnrolledMonitoring();
  await _protegerAbasAbertas();
  return { ...result, warning };
}

// Abas do site abertas antes da instalação não recebem o content script;
// recarrega-as para o tutorial detectar a extensão e traz a primeira para frente.
async function refreshGuardianSiteTabs() {
  try {
    const s = await getSettings();
    const origin = getOrigin(s.backendUrl || API_BASE_URL);
    if (!origin) return;
    const tabs = await chrome.tabs.query({});
    const siteTabs = tabs.filter((t) => t.url && getOrigin(t.url) === origin);
    for (const tab of siteTabs) {
      await chrome.tabs.reload(tab.id).catch(() => {});
    }
    const focus =
      siteTabs.find((t) => /\/dashboard\//.test(t.url)) || siteTabs[0];
    if (focus) {
      await chrome.tabs.update(focus.id, { active: true }).catch(() => {});
      await chrome.windows.update(focus.windowId, { focused: true }).catch(() => {});
    }
  } catch (e) {
    console.warn("[Guardian] Não foi possível atualizar abas do site:", e);
  }
}

// Recebe do content script: título + buscas detectadas + enrollment
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const s = await getSettings();

      // Bypass de sessão: usuário optou por continuar em site WARN/EDUCATE
      if (msg?.type === "WARN_BYPASS") {
        const domain = (msg.domain || "").replace(/^www\./i, "").toLowerCase();
        if (domain) {
          warnBypassSet.add(domain);
          // Libera também no DNR: sem isso a regra de redirect dispararia
          // novamente ao voltar para a URL, prendendo o usuário num laço.
          await adicionarBypassDNR(domain);
          console.log("[Guardian] Bypass de sessão concedido para:", domain);
        }
        // Navega de volta para a URL original no tab do remetente
        if (sender.tab?.id && msg.url) {
          await chrome.tabs.update(sender.tab.id, { url: msg.url });
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "APPLY_NOW") {
        const s = await getSettings();
        await syncBlocklistToDNR(
          s.blocklistDomains || [],
          s.protectionEnabled !== false,
          s.allowlistDomains || [],
          _modoLocal(s),
        );
        sendResponse({ ok: true });
        return;
      }

      // Enrollment - vincula dispositivo via código
      if (msg?.type === "ENROLL_DEVICE") {
        try {
          const auth = await chrome.storage.session.get(["linkToken"]);
          if (!auth.linkToken) throw new Error("A autorização temporária expirou. Entre novamente.");
          const result = await enrollThisBrowser(msg.code, msg.deviceName, auth.linkToken);
          await chrome.storage.session.remove(["linkToken", "authEmail", "authAt"]);
          sendResponse({ ok: true, ...result });
        } catch (e) {
          if (e?.message?.includes("autorização temporária expirou")) {
            await chrome.storage.session.remove(["linkToken", "authEmail", "authAt"]);
          }
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }

      // Ponte com o site GuardIAn (content script webBridge.js)
      if (msg?.type === "WEB_BRIDGE") {
        const trustedOrigin = getOrigin(s.backendUrl || API_BASE_URL);
        const senderOrigin = getOrigin(sender?.url || sender?.origin || "");
        if (!trustedOrigin || senderOrigin !== trustedOrigin) {
          sendResponse({ trusted: false });
          return;
        }

        if (msg.action === "PING") {
          const info = await getEnrollmentInfo();
          sendResponse({
            trusted: true,
            installed: true,
            version: chrome.runtime.getManifest().version,
            browserProtection: true,
            incognitoPolicy: true,
            anonimoPermitido: await _anonimoProtegido(),
            scopedEnrollment: true,
            enrolled: info.isEnrolled,
            requiresAuthorization: info.needsAuthorization,
            deviceId: info.deviceId || null,
          });
          return;
        }

        if (msg.action === "COMPUTER_ID") {
          sendResponse({ trusted: true, id: await ensureComputerId(msg.id) });
          return;
        }

        if (msg.action === "ENROLL") {
          const code = String(msg.code || "").trim().toLowerCase();
          if (!code) {
            sendResponse({ trusted: true, ok: false, error: "Código ausente" });
            return;
          }
          try {
            if (msg.computerId) await ensureComputerId(msg.computerId);
            const result = await enrollThisBrowser(code, null, msg.token);
            sendResponse({ trusted: true, ok: true, ...result });
          } catch (e) {
            sendResponse({
              trusted: true,
              ok: false,
              error: e?.message || String(e),
            });
          }
          return;
        }

        sendResponse({ trusted: true, ok: false, error: "Ação desconhecida" });
        return;
      }

      // Obter informações de enrollment
      if (msg?.type === "GET_ENROLLMENT_INFO") {
        const info = await getEnrollmentInfo();
        sendResponse({ ok: true, ...info });
        return;
      }

      // Obter status de conexão do dispositivo
      if (msg?.type === "GET_CONNECTION_STATUS") {
        const info = await getEnrollmentInfo();
        if (info.isEnrolled) {
          const { cachedPolicy } = await chrome.storage.local.get([
            "cachedPolicy",
          ]);
          const policyDependentName =
            typeof cachedPolicy?.policy?.nomeDependente === "string"
              ? cachedPolicy.policy.nomeDependente.trim()
              : "";
          const dependentNickname =
            info.dependentNickname ||
            s.dependentNickname ||
            policyDependentName;

          if (
            !info.dependentNickname &&
            policyDependentName &&
            s.dependentNickname !== policyDependentName
          ) {
            await chrome.storage.sync.set({
              dependentNickname: policyDependentName,
            });
          }

          sendResponse({
            ok: true,
            enrolled: true,
            deviceId: s.deviceId,
            dependentNickname,
            enrolledAt: s.enrolledAt,
          });
        } else {
          sendResponse({ ok: true, enrolled: false, requiresAuthorization: info.needsAuthorization });
        }
        return;
      }

      // Obter status da política atual
      if (msg?.type === "GET_POLICY_STATUS") {
        try {
          const { cachedPolicy } = await chrome.storage.local.get([
            "cachedPolicy",
          ]);
          if (cachedPolicy?.policy) {
            sendResponse({
              ok: true,
              policy: cachedPolicy.policy,
              lastSync: cachedPolicy.timestamp,
            });
          } else {
            // Tenta sincronizar
            const policy = await syncPolicy();
            sendResponse({
              ok: true,
              policy: policy || null,
              lastSync: Date.now(),
            });
          }
        } catch (e) {
          sendResponse({ ok: false, error: e?.message });
        }
        return;
      }

      // Sincronizar política AGORA (chamado pelo botão da options page)
      if (msg?.type === "SYNC_POLICY_NOW") {
        try {
          console.log("[Guardian] Sincronização manual solicitada");
          const policy = await syncPolicy();
          if (policy) {
            // Redireciona abas já abertas em domínios bloqueados
            const s3Blocked = await getS3Blacklist();
            const allBlocked = [...new Set([...(policy.blockedDomains || []), ...s3Blocked])];
            await _redirectOpenBlockedTabs(allBlocked, policy.mode || "BLOCK");
            sendResponse({
              ok: true,
              policy: policy,
              message: "Política sincronizada com sucesso",
            });
          } else {
            sendResponse({ ok: false, error: "Nenhuma política retornada" });
          }
        } catch (e) {
          console.error("[Guardian] Sync manual failed:", e);
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }

      // Desconectar dispositivo: só com a palavra-chave conferida no servidor
      if (msg?.type === "DISCONNECT_DEVICE") {
        const palavraChave = String(msg.palavraChave || "");
        if (!palavraChave) {
          sendResponse({ ok: false, error: "Digite a palavra-chave para desconectar." });
          return;
        }
        let resultado;
        try {
          resultado = await _protecaoPost("/api/protecao/desconectar", { palavraChave });
        } catch (e) {
          sendResponse({ ok: false, error: "Sem conexão com o GuardIAn. A proteção continua ativa." });
          return;
        }
        if (!resultado?.valida) {
          sendResponse({ ok: false, error: _mensagemTentativa(resultado), ...resultado });
          return;
        }
        await chrome.runtime.setUninstallURL("").catch(() => {});
        await chrome.alarms.clear(HEARTBEAT_ALARM).catch(() => {});
        await clearEnrollment();
        await chrome.storage.local.remove(["cachedPolicy", "palavraChaveDefinida"]);
        await chrome.storage.session.remove(["unlockedUntil"]);
        await syncBlocklistToDNR([], false, []); // Limpa DNR
        sendResponse({ ok: true });
        return;
      }

      // Tela de bloqueio do popup: estado atual
      if (msg?.type === "GET_LOCK_STATUS") {
        const info = await getEnrollmentInfo();
        const { palavraChaveDefinida, anonimoPermitido } = await chrome.storage.local.get([
          "palavraChaveDefinida",
          "anonimoPermitido",
        ]);
        sendResponse({
          ok: true,
          enrolled: info.isEnrolled,
          locked: info.isEnrolled && !(await _estaDesbloqueado()),
          palavraChaveDefinida: palavraChaveDefinida !== false,
          anonimoPermitido: await _anonimoProtegido().catch(() => anonimoPermitido),
          dependentNickname: info.dependentNickname,
        });
        return;
      }

      // Destrava as configurações por 5 minutos com a palavra-chave
      if (msg?.type === "UNLOCK_SETTINGS") {
        try {
          const resultado = await _protecaoPost("/api/protecao/verificar", {
            palavraChave: String(msg.palavraChave || ""),
          });
          if (resultado?.valida) {
            const unlockedUntil = Date.now() + UNLOCK_MS;
            await chrome.storage.session.set({ unlockedUntil });
            await chrome.alarms.create(SETTINGS_LOCK_ALARM, { when: unlockedUntil });
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: _mensagemTentativa(resultado), ...resultado });
          }
        } catch (e) {
          sendResponse({ ok: false, error: "Sem conexão com o GuardIAn. Tente de novo em instantes." });
        }
        return;
      }

      if (msg?.type === "LOCK_SETTINGS") {
        await chrome.storage.session.remove(["unlockedUntil"]);
        await chrome.alarms.clear(SETTINGS_LOCK_ALARM);
        await _protegerAbasAbertas();
        sendResponse({ ok: true });
        return;
      }

      // Palavra-chave no fluxo "pai e filho em computadores diferentes"
      if (msg?.type === "KEYWORD_STATUS") {
        try {
          const auth = await chrome.storage.session.get(["linkToken"]);
          if (!auth.linkToken) throw new Error("Entre com a conta do responsável.");
          sendResponse({ ok: true, definida: await getKeywordStatus(auth.linkToken, await _baseUrl()) });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }

      if (msg?.type === "SET_KEYWORD") {
        try {
          const auth = await chrome.storage.session.get(["linkToken"]);
          if (!auth.linkToken) throw new Error("Entre com a conta do responsável.");
          await setKeyword(auth.linkToken, String(msg.palavraChave || ""), await _baseUrl());
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }

      // Login do responsável
      if (msg?.type === "LOGIN") {
        try {
          const baseUrl = s.backendUrl || API_BASE_URL;
          const result = await loginUser(msg.email, msg.password, baseUrl);
          if (!result.token) throw new Error("O servidor não retornou uma autorização de vínculo.");
          const info = await getEnrollmentInfo();
          if (info.needsAuthorization) {
            try {
              const authorization = await authorizeExistingDevice(info.deviceId, result.token, baseUrl);
              if (!authorization.token) throw new Error("O servidor não retornou a autorização do dispositivo.");
              await chrome.storage.local.set({ deviceToken: authorization.token });
              await chrome.storage.session.remove(["linkToken", "authEmail", "authAt"]);
            } catch (error) {
              try { await logoutUser(result.token, baseUrl); }
              catch (logoutError) {
                throw new Error("Não foi possível atualizar o vínculo nem encerrar a autorização temporária.");
              }
              throw error;
            }
            const warning = await initializeEnrolledMonitoring();
            sendResponse({ ok: true, migrated: true, warning });
          } else {
            await chrome.storage.session.set({
              linkToken: result.token,
              authEmail: msg.email,
              authAt: Date.now(),
            });
            sendResponse({ ok: true });
          }
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }

      // Registro de novo usuário
      if (msg?.type === "REGISTER") {
        try {
          const baseUrl = s.backendUrl || API_BASE_URL;
          await registerUser(msg.email, msg.password, baseUrl);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }

      // Logout
      if (msg?.type === "LOGOUT") {
        const auth = await chrome.storage.session.get(["linkToken"]);
        try {
          await logoutUser(auth.linkToken, s.backendUrl || API_BASE_URL);
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || String(error) });
        } finally {
          await chrome.storage.session.remove(["linkToken", "authEmail", "authAt"]);
          await chrome.storage.local.remove(["authToken", "authEmail", "authAt"]);
        }
        return;
      }

      // Verificar se está logado
      if (msg?.type === "GET_AUTH_STATUS") {
        const auth = await chrome.storage.session.get([
          "linkToken",
          "authEmail",
          "authAt",
        ]);
        if (auth.linkToken && (!auth.authAt || Date.now() - auth.authAt >= 10 * 60 * 1000)) {
          await chrome.storage.session.remove(["linkToken", "authEmail", "authAt"]);
          sendResponse({ ok: true, isLoggedIn: false, email: null });
          return;
        }
        sendResponse({
          ok: true,
          isLoggedIn: !!auth.linkToken,
          email: auth.authEmail || null,
          authAt: auth.authAt || null,
        });
        return;
      }

      // Sincronizar política do backend
      if (msg?.type === "SYNC_POLICY") {
        try {
          await invalidatePolicyCache(); // Força nova busca
          const policy = await syncPolicy();

          if (policy) {
            // O DNR já foi aplicado por syncPolicy() com os domínios corretos
            // para o modo vigente. Reaplicar aqui com policy.blockedDomains
            // (backend + S3) desfaria a exclusão feita para WARN/EDUCATE.
            sendResponse({ ok: true, policy });
          } else {
            sendResponse({ ok: false, error: "Não foi possível sincronizar" });
          }
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }

      // Buscar política atual do backend (GET direto)
      if (msg?.type === "GET_BACKEND_POLICY") {
        try {
          const baseUrl = s.backendUrl || API_BASE_URL;
          const policy = await fetchPolicy(s.deviceId, baseUrl);
          sendResponse({ ok: true, policy });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }

      // Atualizar política no backend (PUT)
      if (msg?.type === "UPDATE_POLICY") {
        sendResponse({ ok: false, error: "Altere a política no painel do responsável." });
        return;
      }

      // Título real de vídeo/conteúdo carregou — classifica via IA agora e bloqueia se necessário
      if (msg?.type === "CLASSIFICAR_AGORA") {
        const pageUrl = msg.url || "";
        if (!pageUrl.startsWith("http")) { sendResponse({ ok: true }); return; }

        const currentSettings = await getSettings();
        const deviceId = currentSettings.deviceId;
        if (!deviceId) { sendResponse({ ok: true }); return; }

        const baseUrl = currentSettings.backendUrl || API_BASE_URL;
        try {
          const resp = await authenticatedDeviceFetch("/api/blocklist/classificar-agora", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: pageUrl,
              titulo: msg.title || "",
              descricao: msg.descricao || "",
              restricaoEtaria: msg.restricaoEtaria || false,
              categoria: msg.categoria || "",
              dispositivoId: deviceId,
            }),
          }, baseUrl);

          if (resp.ok) {
            const resultado = await resp.json();
            console.log("[Guardian] ClassificarAgora:", pageUrl, "→", resultado.acao, resultado.motivo);

            // EDUCATE não interfere — o acesso fica registrado, mas a página
            // do usuário não é substituída.
            const acao = resultado.acao;
            if (acao === "BLOCK" || acao === "WARN") {
              const tabId = sender.tab?.id;
              if (tabId) {
                const host = new URL(pageUrl).hostname.replace(/^www\./i, "").toLowerCase();
                const targetPage =
                  acao === "WARN"
                    ? chrome.runtime.getURL(`src/warned/warn.html?domain=${encodeURIComponent(host)}&url=${encodeURIComponent(pageUrl)}`)
                    : chrome.runtime.getURL(`src/blocked/blocked.html?domain=${encodeURIComponent(host)}&url=${encodeURIComponent(pageUrl)}`);
                await chrome.tabs.update(tabId, { url: targetPage });
                console.log("[Guardian] Intercepção imediata por IA:", pageUrl, "→", acao);
              }
            } else if (acao === "EDUCATE") {
              console.log("[Guardian] Modo EDUCATE — apenas registrado:", pageUrl);
            }
          }
        } catch (e) {
          console.warn("[Guardian] ClassificarAgora falhou:", e?.message);
        }
        sendResponse({ ok: true });
        return;
      }

      // PAGE_META_UPDATED: título real da plataforma mista carregou.
      // NÃO enfileira evento — o onHistoryStateUpdated já fez isso com o título real.
      // Apenas responde ok para não bloquear o content script.
      if (msg?.type === "PAGE_META_UPDATED") {
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "PAGE_META") {
        const pageUrl = msg.url || "";
        if (pageUrl.startsWith("http://") || pageUrl.startsWith("https://")) {
          const pageHost = new URL(pageUrl).hostname.toLowerCase();

          // Ignora PAGE_META de plataformas mistas em páginas de conteúdo específico
          // (ex: youtube.com/watch?v=...) — o onHistoryStateUpdated já enfileira
          // com o título real após aguardar o carregamento. Evita duplicatas.
          const ehPlataformaMistaMsg = PLATAFORMAS_MISTAS_SW.has(pageHost);
          const ehConteudoMsg = _ehConteudoEspecifico(pageHost, pageUrl);
          if (ehPlataformaMistaMsg && ehConteudoMsg) {
            sendResponse({ ok: true });
            return;
          }

          // Ignora títulos genéricos de plataformas (ex: "YouTube", "Twitch")
          const tituloGenerico = ["YouTube", "Twitch", "TikTok", "Reddit", ""].includes(
            (msg.title || "").trim()
          );
          if (ehPlataformaMistaMsg && tituloGenerico) {
            sendResponse({ ok: true });
            return;
          }

          await enqueueEvent({
            type: EVENT_TYPES.NAVIGATION,
            ts: Date.now(),
            occurredAt: new Date().toISOString(),
            url: pageUrl,
            title: msg.title,
            metadata: { domain: msg.domain },
          });
          _uploadImediato(s);
        }
      }

      if (msg?.type === "SEARCH_QUERY") {
        await enqueueEvent({
          type: EVENT_TYPES.SEARCH_QUERY,
          ts: Date.now(),
          occurredAt: new Date().toISOString(),
          url: msg.url,
          title: "",
          metadata: {
            engine: msg.engine,
            query: msg.query,
            domain: msg.domain,
          },
        });
      }

      // Reportar tentativa de bloqueio
      if (msg?.type === "BLOCK_ATTEMPT") {
        console.log("[Guardian] Registrando tentativa de bloqueio:", msg.url);
        await enqueueEvent({
          type: EVENT_TYPES.BLOCK_ATTEMPT,
          ts: Date.now(),
          occurredAt: new Date().toISOString(),
          url: msg.url,
          title: "Tentativa de acesso bloqueado",
          metadata: {
            reason: msg.reason || "domain_blocked",
            domain: msg.domain,
          },
        });

        // Tenta enviar imediatamente
        const s = await getSettings();
        const enrolled = await isEnrolled();

        if (enrolled && s.deviceId) {
          try {
            await uploadQueued(s, 10);
          } catch (e) {
            console.warn("[Guardian] Upload imediato falhou:", e?.message || e);
          }
        } else {
          console.log("[Guardian] Não enrolled, evento armazenado localmente");
        }
      }

      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});
