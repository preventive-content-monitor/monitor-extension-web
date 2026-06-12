import {
  ensureDefaults,
  isEnrolled,
  enrollWithCode,
  getEnrollmentInfo,
  generateDeviceName,
} from "./deviceIdentity.js";
import { getSettings } from "./policyStore.js";
import { enqueueEvent, drainQueue } from "./eventQueue.js";
import {
  postEventsBatch,
  fetchPolicy,
  updatePolicy,
  loginUser,
  registerUser,
} from "./apiClient.js";
import { EVENT_TYPES, API_BASE_URL, EVENTS_API_URL } from "../shared/constants.js";
import { syncBlocklistToDNR } from "./dnrRules.js";
import { syncPolicy, invalidatePolicyCache } from "./policySync.js";
import { refreshS3Blocklist, getS3Blacklist } from "./blocklistSync.js";

let uploadTimer = null;
let policySyncTimer = null;
let s3RefreshTimer = null;

// Domínios que o usuário optou por continuar acessando na sessão atual (WARN/EDUCATE bypass)
const warnBypassSet = new Set();

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await ensureDefaults();

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
      );
    }

    await startUploadLoop();
    await startPolicySyncLoop();
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

    // Baixa S3 blacklist ANTES de sincronizar política
    await refreshS3Blocklist().catch((e) =>
      console.warn("[Guardian] S3 refresh falhou no startup:", e.message),
    );

    await syncPolicy();

    await startUploadLoop();
    await startPolicySyncLoop();
  } catch (e) {
    console.error("onStartup failed:", e);
  }
});

/**
 * Após atualizar o DNR, redireciona abas já abertas que estejam em domínios bloqueados.
 * Isso evita que o usuário precise dar F5 para ver o bloqueio.
 */
async function _redirectOpenBlockedTabs(blockedDomains, mode) {
  if (!blockedDomains || blockedDomains.length === 0) return;
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    const blockedPage  = chrome.runtime.getURL("src/blocked/blocked.html");
    const warnPage     = chrome.runtime.getURL("src/warned/warn.html");
    const educatePage  = chrome.runtime.getURL("src/educate/educate.html");
    const policyMode   = mode || "BLOCK";

    for (const tab of tabs) {
      try {
        // Ignora abas já em páginas de ação do Guardian
        const u = tab.url || "";
        if (u.startsWith(blockedPage) || u.startsWith(warnPage) || u.startsWith(educatePage)) continue;

        const host = new URL(u).hostname.replace(/^www\./i, "").toLowerCase();

        // Bypass de sessão
        if (warnBypassSet.has(host)) continue;

        const match = blockedDomains.find(
          (d) => host === d || host.endsWith("." + d),
        );
        if (match) {
          let targetPage;
          if (policyMode === "WARN") {
            targetPage = `${warnPage}?url=${encodeURIComponent(u)}&domain=${encodeURIComponent(host)}`;
          } else if (policyMode === "EDUCATE") {
            targetPage = `${educatePage}?url=${encodeURIComponent(u)}&domain=${encodeURIComponent(host)}`;
          } else {
            targetPage = `${blockedPage}?url=${encodeURIComponent(u)}`;
          }
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
      );
    }

    // Se mudou backendUrl/uploadEnabled etc, reinicia loop
    await startUploadLoop();
  } catch (e) {
    console.error("onChanged failed:", e);
  }
});

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
    EVENTS_API_URL,
  );

  // Faz upload imediato se tiver eventos pendentes
  try {
    const batch = await drainQueue(200);
    if (batch.length > 0) {
      console.log("[Guardian] Enviando", batch.length, "eventos pendentes");
      await postEventsBatch(s.deviceId, batch, EVENTS_API_URL);
    }
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

        const batch = await drainQueue(200);
        if (batch.length === 0) return;
        console.log(
          "[Guardian] Enviando",
          batch.length,
          "eventos para",
          EVENTS_API_URL,
        );
        await postEventsBatch(
          currentSettings.deviceId,
          batch,
          EVENTS_API_URL,
        );
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
          const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/blocklist/classificar-agora`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, titulo, dispositivoId: s.deviceId }),
            // Contexto adicional será enriquecido via CLASSIFICAR_AGORA do content script
          });
          if (resp.ok) {
            const resultado = await resp.json();
            console.log("[Guardian] SPA classificação:", url, "→", resultado.acao, resultado.motivo);

            const acao = resultado.acao;
            if (acao === "BLOCK" || acao === "WARN" || acao === "EDUCATE") {
              const h2 = u.hostname.replace(/^www\./i, "").toLowerCase();
              let targetPage;
              if (acao === "WARN") {
                targetPage = chrome.runtime.getURL(`src/warned/warn.html?url=${encodeURIComponent(url)}&domain=${encodeURIComponent(h2)}`);
              } else if (acao === "EDUCATE") {
                targetPage = chrome.runtime.getURL(`src/educate/educate.html?url=${encodeURIComponent(url)}&domain=${encodeURIComponent(h2)}`);
              } else {
                targetPage = chrome.runtime.getURL(`src/blocked/blocked.html?url=${encodeURIComponent(url)}`);
              }
              await chrome.tabs.update(details.tabId, { url: targetPage });
              console.log("[Guardian] SPA bloqueio imediato:", url, "→", acao);
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
 * BLOCK → blocked.html | WARN → warn.html (bypassável) | EDUCATE → educate.html
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

    const h = hostname.replace(/^www\./i, "").toLowerCase();

    // Verifica bypass de sessão (usuário optou por continuar em WARN/EDUCATE)
    if (warnBypassSet.has(h)) return;

    const match = blocked.find((entry) => {
      if (entry.includes("/")) {
        return urlLower.includes(entry.toLowerCase());
      } else {
        const d = entry.replace(/^www\./i, "").toLowerCase();
        return h === d || h.endsWith("." + d);
      }
    });

    if (match) {
      let targetPage;
      if (mode === "WARN") {
        targetPage = chrome.runtime.getURL(
          `src/warned/warn.html?url=${encodeURIComponent(url)}&domain=${encodeURIComponent(h)}`,
        );
        console.log("[Guardian] Aviso WARN:", url, "→", match);
      } else if (mode === "EDUCATE") {
        targetPage = chrome.runtime.getURL(
          `src/educate/educate.html?url=${encodeURIComponent(url)}&domain=${encodeURIComponent(h)}`,
        );
        console.log("[Guardian] Aviso EDUCATE:", url, "→", match);
      } else {
        targetPage = chrome.runtime.getURL(
          `src/blocked/blocked.html?url=${encodeURIComponent(url)}`,
        );
        console.log("[Guardian] Bloqueio BLOCK:", url, "→", match);
      }
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
    const batch = await drainQueue(50);
    if (batch.length > 0) {
      await postEventsBatch(s.deviceId, batch, EVENTS_API_URL);
    }
  } catch (e) {
    // silencia — o timer de 10s tentará novamente
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
        );
        sendResponse({ ok: true });
        return;
      }

      // Enrollment - vincula dispositivo via código
      if (msg?.type === "ENROLL_DEVICE") {
        try {
          const deviceName = msg.deviceName || generateDeviceName();
          const baseUrl = s.backendUrl || API_BASE_URL;
          const result = await enrollWithCode(msg.code, deviceName, baseUrl);

          // Reinicia loops de upload e sync após enrollment
          await startUploadLoop();
          await startPolicySyncLoop();

          // Sincroniza política imediatamente e redireciona abas já abertas
          const enrolledPolicy = await syncPolicy();
          if (enrolledPolicy) {
            const s3Blocked = await getS3Blacklist();
            const allBlocked = [...new Set([...(enrolledPolicy.blockedDomains || []), ...s3Blocked])];
            await _redirectOpenBlockedTabs(allBlocked, enrolledPolicy.mode || "BLOCK");
          }

          sendResponse({ ok: true, ...result });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
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
        const enrolled = await isEnrolled();
        if (enrolled) {
          const info = await getEnrollmentInfo();
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
          sendResponse({ ok: true, enrolled: false });
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
            await _redirectOpenBlockedTabs(allBlocked);
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

      // Desconectar dispositivo
      if (msg?.type === "DISCONNECT_DEVICE") {
        await chrome.storage.sync.remove([
          "deviceId",
          "enrolledAt",
          "dependentId",
          "dependentNickname",
        ]);
        await chrome.storage.local.remove(["cachedPolicy"]);
        await syncBlocklistToDNR([], false, []); // Limpa DNR
        sendResponse({ ok: true });
        return;
      }

      // Login do responsável
      if (msg?.type === "LOGIN") {
        try {
          const baseUrl = s.backendUrl || API_BASE_URL;
          const result = await loginUser(msg.email, msg.password, baseUrl);

          // Salva o token no storage
          await chrome.storage.local.set({
            authToken: result.token,
            authEmail: msg.email,
            authAt: Date.now(),
          });

          sendResponse({ ok: true, token: result.token });
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
        await chrome.storage.local.remove(["authToken", "authEmail", "authAt"]);
        sendResponse({ ok: true });
        return;
      }

      // Verificar se está logado
      if (msg?.type === "GET_AUTH_STATUS") {
        const auth = await chrome.storage.local.get([
          "authToken",
          "authEmail",
          "authAt",
        ]);
        sendResponse({
          ok: true,
          isLoggedIn: !!auth.authToken,
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
            // Se veio do backend, atualiza DNR com blocklist do backend
            if (policy.fromBackend) {
              await syncBlocklistToDNR(
                policy.blockedDomains || [],
                policy.protectionEnabled !== false,
                policy.allowedDomains || [],
              );
            }
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
        if (!s.deviceId || !s.enrolledAt) {
          sendResponse({ ok: false, error: "Dispositivo não conectado" });
          return;
        }

        // Busca token do storage
        const auth = await chrome.storage.local.get(["authToken"]);
        if (!auth.authToken) {
          sendResponse({
            ok: false,
            error: "Faça login para sincronizar configurações",
          });
          return;
        }

        try {
          const baseUrl = s.backendUrl || API_BASE_URL;
          const result = await updatePolicy(
            s.deviceId,
            msg.policy,
            auth.authToken,
            baseUrl,
          );
          await invalidatePolicyCache(); // Força re-sync
          sendResponse({ ok: true, result });
        } catch (e) {
          // Se token expirou, limpa auth
          if (e?.message?.includes("401") || e?.message?.includes("expirada")) {
            await chrome.storage.local.remove([
              "authToken",
              "authEmail",
              "authAt",
            ]);
          }
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
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
          const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/blocklist/classificar-agora`, {
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
          });

          if (resp.ok) {
            const resultado = await resp.json();
            console.log("[Guardian] ClassificarAgora:", pageUrl, "→", resultado.acao, resultado.motivo);

            const acao = resultado.acao;
            if (acao === "BLOCK" || acao === "WARN" || acao === "EDUCATE") {
              const tabId = sender.tab?.id;
              if (tabId) {
                const host = new URL(pageUrl).hostname.replace(/^www\./i, "").toLowerCase();
                let targetPage;
                if (acao === "WARN") {
                  targetPage = chrome.runtime.getURL(`src/warned/warn.html?url=${encodeURIComponent(pageUrl)}&domain=${encodeURIComponent(host)}`);
                } else if (acao === "EDUCATE") {
                  targetPage = chrome.runtime.getURL(`src/educate/educate.html?url=${encodeURIComponent(pageUrl)}&domain=${encodeURIComponent(host)}`);
                } else {
                  targetPage = chrome.runtime.getURL(`src/blocked/blocked.html?url=${encodeURIComponent(pageUrl)}`);
                }
                await chrome.tabs.update(tabId, { url: targetPage });
                console.log("[Guardian] Bloqueio imediato por IA:", pageUrl, "→", acao);
              }
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
            const batch = await drainQueue(10);
            if (batch.length > 0) {
              console.log(
                "[Guardian] Enviando evento de bloqueio imediatamente para deviceId:",
                s.deviceId,
              );
              await postEventsBatch(s.deviceId, batch, EVENTS_API_URL);
            }
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
