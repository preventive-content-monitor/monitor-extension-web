import { ensureDefaults, isEnrolled, enrollWithCode, getEnrollmentInfo, generateDeviceName } from "./deviceIdentity.js";
import { getSettings } from "./policyStore.js";
import { enqueueEvent, drainQueue } from "./eventQueue.js";
import { postEventsBatch, fetchPolicy, updatePolicy, loginUser, registerUser } from "./apiClient.js";
import { EVENT_TYPES, API_BASE_URL } from "../shared/constants.js";
import { syncBlocklistToDNR } from "./dnrRules.js";
import { syncPolicy, invalidatePolicyCache } from "./policySync.js";

let uploadTimer = null;
let policySyncTimer = null;

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await ensureDefaults();
    
    // Se já está enrolled, garante que upload está habilitado
    const enrolled = await isEnrolled();
    if (enrolled) {
      const s = await getSettings();
      if (!s.uploadEnabled) {
        console.log("[Guardian] Habilitando upload para dispositivo já enrolled");
        await chrome.storage.sync.set({ 
          uploadEnabled: true,
          backendUrl: s.backendUrl || API_BASE_URL
        });
      }
    }
    
    // Tenta sincronizar política do backend primeiro
    const policy = await syncPolicy();
    
    // Se não conseguiu (não enrolled ou erro), usa local
    if (!policy) {
      const s = await getSettings();
      await syncBlocklistToDNR(
        s.blocklistDomains || [],
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
        console.log("[Guardian] Habilitando upload para dispositivo já enrolled");
        await chrome.storage.sync.set({ 
          uploadEnabled: true,
          backendUrl: s.backendUrl || API_BASE_URL
        });
      }
    }
    
    await syncPolicy();
    await startUploadLoop();
    await startPolicySyncLoop();
  } catch (e) {
    console.error("onStartup failed:", e);
  }
});

async function startPolicySyncLoop() {
  if (policySyncTimer) clearInterval(policySyncTimer);
  
  // Sincroniza política a cada 30 segundos para pegar mudanças do dashboard
  policySyncTimer = setInterval(async () => {
    try {
      const policy = await syncPolicy();
      if (policy) {
        console.log("[Guardian] Policy synced - allowed:", policy.allowedDomains?.length || 0, "blocked:", policy.blockedDomains?.length || 0);
      }
    } catch (e) {
      console.warn("[Guardian] Policy sync failed:", e.message);
    }
  }, 30 * 1000); // 30 segundos
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
  const backendUrl = s.backendUrl || API_BASE_URL;
  const canUpload = enrolled && s.deviceId;
  
  if (!canUpload) {
    console.log("[Guardian] Upload desabilitado:", { 
      enrolled,
      deviceId: !!s.deviceId
    });
    return;
  }

  console.log("[Guardian] Upload habilitado, iniciando loop para deviceId:", s.deviceId, "backend:", backendUrl);

  // Faz upload imediato se tiver eventos pendentes
  try {
    const batch = await drainQueue(200);
    if (batch.length > 0) {
      console.log("[Guardian] Enviando", batch.length, "eventos pendentes");
      await postEventsBatch(s.deviceId, batch, backendUrl);
    }
  } catch (e) {
    console.warn("[Guardian] Upload inicial falhou:", e?.message || e);
  }

  uploadTimer = setInterval(
    async () => {
      try {
        // Re-busca settings a cada iteração para pegar deviceId atualizado
        const currentSettings = await getSettings();
        const currentBackendUrl = currentSettings.backendUrl || API_BASE_URL;
        
        if (!currentSettings.deviceId) {
          console.log("[Guardian] Upload ignorado - sem deviceId");
          return;
        }
        
        const batch = await drainQueue(200);
        if (batch.length === 0) return;
        console.log("[Guardian] Enviando", batch.length, "eventos para", currentBackendUrl);
        await postEventsBatch(currentSettings.deviceId, batch, currentBackendUrl);
      } catch (e) {
        console.warn("[Guardian] Upload failed:", e?.message || e);
      }
    },
    (s.uploadIntervalSec || 30) * 1000,
  );
}

// Log de navegação (URL visitada)
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  try {
    const s = await getSettings();
    const url = details.url || "";
    const u = new URL(url);

    await enqueueEvent({
      type: EVENT_TYPES.NAVIGATION,
      ts: Date.now(),
      occurredAt: new Date().toISOString(),
      url,
      title: "",
      metadata: {
        domain: u.hostname,
        tabId: details.tabId,
        transitionType: details.transitionType || null,
      },
    });
  } catch (e) {
    console.warn("webNavigation log failed:", e?.message || e);
  }
});

// Recebe do content script: título + buscas detectadas + enrollment
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const s = await getSettings();

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
          
          // Sincroniza política imediatamente
          await syncPolicy();
          
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
          sendResponse({ 
            ok: true, 
            enrolled: true,
            deviceId: s.deviceId,
            dependentNickname: info.dependentNickname || s.dependentNickname,
            enrolledAt: s.enrolledAt
          });
        } else {
          sendResponse({ ok: true, enrolled: false });
        }
        return;
      }

      // Obter status da política atual
      if (msg?.type === "GET_POLICY_STATUS") {
        try {
          const { cachedPolicy } = await chrome.storage.local.get(["cachedPolicy"]);
          if (cachedPolicy?.policy) {
            sendResponse({ 
              ok: true, 
              policy: cachedPolicy.policy,
              lastSync: cachedPolicy.timestamp
            });
          } else {
            // Tenta sincronizar
            const policy = await syncPolicy();
            sendResponse({ 
              ok: true, 
              policy: policy || null,
              lastSync: Date.now()
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
            sendResponse({ 
              ok: true, 
              policy: policy,
              message: "Política sincronizada com sucesso"
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
          "dependentNickname"
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
            authAt: Date.now()
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
        const auth = await chrome.storage.local.get(["authToken", "authEmail", "authAt"]);
        sendResponse({ 
          ok: true, 
          isLoggedIn: !!auth.authToken,
          email: auth.authEmail || null,
          authAt: auth.authAt || null
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
          sendResponse({ ok: false, error: "Faça login para sincronizar configurações" });
          return;
        }
        
        try {
          const baseUrl = s.backendUrl || API_BASE_URL;
          const result = await updatePolicy(s.deviceId, msg.policy, auth.authToken, baseUrl);
          await invalidatePolicyCache(); // Força re-sync
          sendResponse({ ok: true, result });
        } catch (e) {
          // Se token expirou, limpa auth
          if (e?.message?.includes("401") || e?.message?.includes("expirada")) {
            await chrome.storage.local.remove(["authToken", "authEmail", "authAt"]);
          }
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }

      if (msg?.type === "PAGE_META") {
        await enqueueEvent({
          type: EVENT_TYPES.NAVIGATION,
          ts: Date.now(),
          occurredAt: new Date().toISOString(),
          url: msg.url,
          title: msg.title,
          metadata: {
            domain: msg.domain,
          },
        });
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
        const backendUrl = s.backendUrl || API_BASE_URL;
        
        if (enrolled && s.deviceId) {
          try {
            const batch = await drainQueue(10);
            if (batch.length > 0) {
              console.log("[Guardian] Enviando evento de bloqueio imediatamente para deviceId:", s.deviceId);
              await postEventsBatch(s.deviceId, batch, backendUrl);
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
