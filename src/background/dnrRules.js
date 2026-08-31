import { normalizeDomain } from "./policyStore.js";

const RULESET_ID_BASE = 1000;
const WHITELIST_RULE_ID = 999; // ID especial para a regra "bloquear tudo"

// Regras de bypass de sessão ficam FORA da faixa que syncBlocklistToDNR limpa,
// senão o sync de política (a cada 5s) apagaria o "continuar assim mesmo"
// que o usuário acabou de conceder.
const BYPASS_ID_BASE = 20000;
const BYPASS_ID_MAX = 20999;

// Prioridade maior que as regras de bloqueio (priority 1) — uma regra allow
// de prioridade 2 vence o redirect e libera o domínio.
const BYPASS_PRIORITY = 2;

// Páginas de intercepção da extensão.
// Não há página para EDUCATE: esse modo apenas registra a navegação.
const BLOCKED_PAGE_BASE = chrome.runtime.getURL("src/blocked/blocked.html");
const WARN_PAGE_BASE = chrome.runtime.getURL("src/warned/warn.html");

/**
 * Substituição de destino conforme o modo da política, preservando a URL real.
 *
 * O `\1` é preenchido pelo DNR com a URL que o usuário tentou acessar (capturada
 * pelo regexFilter). Sem isso o redirect seria estático e o "continuar assim
 * mesmo" levaria à raiz do domínio em vez da página pedida.
 *
 * O parâmetro `url` vem POR ÚLTIMO de propósito: a URL capturada entra crua, e
 * se ela tiver query string (`?v=X&t=30`) os `&` seriam lidos como novos
 * parâmetros. Ficando por último, as páginas recuperam tudo que vem depois de
 * "url=" — ver a leitura em warn.js / blocked.js.
 *
 * EDUCATE não aparece aqui: nesse modo nada é interceptado (ver INTERCEPTA_CONTEUDO).
 */
function substituicaoDeIntercepcao(mode, dominio) {
  const dom = encodeURIComponent(dominio);

  if (mode === "WARN") return `${WARN_PAGE_BASE}?domain=${dom}&url=\\1`;
  return `${BLOCKED_PAGE_BASE}?domain=${dom}&url=\\1`;
}

/**
 * EDUCATE apenas registra a navegação, sem interferir na tela do usuário.
 * A captura de eventos e os alertas ao responsável seguem funcionando —
 * eles não dependem da interceptação.
 */
export function INTERCEPTA_CONTEUDO(mode) {
  return mode !== "EDUCATE";
}

// Captura a URL inteira. Combinado com requestDomains/regexFilter na condição,
// o grupo 1 vira a URL exata que o usuário tentou abrir.
const CAPTURA_URL_COMPLETA = "^(https?://.*)$";

/**
 * Sincroniza regras de bloqueio/permissão com o DNR
 * @param {string[]} blockedDomains - Domínios a bloquear (modo blacklist)
 * @param {boolean} enabled - Se a proteção está habilitada
 * @param {string[]} allowedDomains - Domínios permitidos (modo whitelist)
 * @param {string} mode - Modo da política: BLOCK | WARN | EDUCATE.
 *        BLOCK redireciona para a tela de bloqueio, WARN para a de aviso
 *        (bypassável) e EDUCATE não interfere — apenas registra a navegação.
 */
export async function syncBlocklistToDNR(
  blockedDomains = [],
  enabled = true,
  allowedDomains = [],
  mode = "BLOCK",
) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const toRemove = existing
    .filter((r) => r.id >= WHITELIST_RULE_ID && r.id < RULESET_ID_BASE + 10000)
    .map((r) => r.id);

  // Sempre remove o que a gente gerou antes
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: toRemove,
    addRules: [],
  });

  // Se estiver desabilitado, para aqui (sem adicionar nada)
  if (!enabled) {
    console.log("[Guardian DNR] Proteção desabilitada");
    return;
  }

  // EDUCATE não interfere na navegação: nenhuma regra é criada.
  // Os eventos continuam sendo capturados e enviados ao backend, então o
  // responsável segue vendo as Atividades e recebendo alertas.
  if (!INTERCEPTA_CONTEUDO(mode)) {
    console.log("[Guardian DNR] Modo EDUCATE - navegação apenas registrada, sem bloqueio");
    return;
  }

  const cleanedAllowed = [
    ...new Set(allowedDomains.map(normalizeDomain).filter(Boolean)),
  ];
  const cleanedBlocked = [
    ...new Set(blockedDomains.map(normalizeDomain).filter(Boolean)),
  ];

  let newRules = [];

  // MODO WHITELIST: Se tem allowedDomains, bloqueia TUDO exceto esses sites
  if (cleanedAllowed.length > 0) {
    console.log(
      "[Guardian DNR] Modo WHITELIST ativo - apenas permitidos:",
      cleanedAllowed,
    );

    // Estratégia: Uma única regra que bloqueia tudo EXCETO os domínios permitidos
    // Usa excludedRequestDomains para a whitelist - muito mais confiável que regexFilter
    newRules.push({
      id: WHITELIST_RULE_ID,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          url: `${BLOCKED_PAGE_BASE}?url=site-nao-permitido&mode=whitelist`,
        },
      },
      // A whitelist é uma escolha explícita do responsável ("só estes sites"),
      // então continua sendo bloqueio duro mesmo em WARN/EDUCATE.
      condition: {
        urlFilter: "|http", // Matcha qualquer URL que começa com http (inclui https)
        excludedRequestDomains: cleanedAllowed, // EXCETO estes domínios
        resourceTypes: ["main_frame"],
      },
    });

    console.log(
      "[Guardian DNR] Regra whitelist criada - bloqueando tudo exceto:",
      cleanedAllowed,
    );
  } else if (cleanedBlocked.length > 0) {
    // MODO BLACKLIST: Bloqueia apenas os domínios/URLs específicos
    console.log(
      "[Guardian DNR] Modo BLACKLIST ativo - bloqueados:",
      cleanedBlocked,
    );

    newRules = cleanedBlocked.slice(0, 5000).map((d, idx) => {
      // Domínio usado no parâmetro da página de aviso (parte antes da "/")
      const dominio = d.split("/")[0];

      // Entradas com "/" são padrões de URL específicos (ex: youtube.com/watch?v=abc).
      // O regexFilter precisa casar a URL inteira para o grupo 1 capturá-la,
      // então o padrão do conteúdo vira um "contém" dentro da captura.
      if (d.includes("/")) {
        // Escapa caracteres especiais de regex, exceto já escapados
        const escaped = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return {
          id: RULESET_ID_BASE + idx,
          priority: 1,
          action: {
            type: "redirect",
            redirect: {
              regexSubstitution: substituicaoDeIntercepcao(mode, dominio),
            },
          },
          condition: {
            regexFilter: `^(https?://.*${escaped}.*)$`,
            resourceTypes: ["main_frame"],
          },
        };
      }
      // Entradas sem "/" são domínios puros — bloqueia o domínio inteiro.
      // requestDomains faz o casamento do domínio (confiável, inclui subdomínios)
      // e o regexFilter existe só para capturar a URL na substituição.
      return {
        id: RULESET_ID_BASE + idx,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            regexSubstitution: substituicaoDeIntercepcao(mode, dominio),
          },
        },
        condition: {
          requestDomains: [d],
          regexFilter: CAPTURA_URL_COMPLETA,
          resourceTypes: ["main_frame"],
        },
      };
    });
  }

  if (newRules.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [],
      addRules: newRules,
    });
    console.log("[Guardian DNR] Aplicadas", newRules.length, "regras");
  }
}

/**
 * Libera um domínio no DNR após o usuário optar por continuar em WARN/EDUCATE.
 *
 * Sem isso o bypass não funcionaria: a regra de redirect do DNR dispararia de
 * novo ao voltar para a URL, prendendo o usuário num laço na página de aviso.
 */
export async function adicionarBypassDNR(domain) {
  const d = normalizeDomain(domain);
  if (!d) return;

  const existentes = await chrome.declarativeNetRequest.getDynamicRules();
  const bypasses = existentes.filter(
    (r) => r.id >= BYPASS_ID_BASE && r.id <= BYPASS_ID_MAX,
  );

  // Já liberado nesta sessão
  if (bypasses.some((r) => r.condition?.requestDomains?.includes(d))) return;

  const idsUsados = new Set(bypasses.map((r) => r.id));
  let id = BYPASS_ID_BASE;
  while (idsUsados.has(id) && id <= BYPASS_ID_MAX) id++;

  if (id > BYPASS_ID_MAX) {
    console.warn("[Guardian DNR] Limite de regras de bypass atingido");
    return;
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [],
    addRules: [
      {
        id,
        priority: BYPASS_PRIORITY,
        action: { type: "allow" },
        condition: {
          requestDomains: [d],
          resourceTypes: ["main_frame"],
        },
      },
    ],
  });

  console.log("[Guardian DNR] Bypass concedido para", d);
}

/**
 * Remove todas as liberações de bypass.
 *
 * O bypass é de sessão (o warnBypassSet do serviceWorker vive em memória), mas
 * regras do DNR persistem entre reinícios — então precisam ser limpas no
 * install/startup para não sobreviverem além da sessão que as criou.
 */
export async function limparBypassDNR() {
  const existentes = await chrome.declarativeNetRequest.getDynamicRules();
  const ids = existentes
    .filter((r) => r.id >= BYPASS_ID_BASE && r.id <= BYPASS_ID_MAX)
    .map((r) => r.id);

  if (ids.length === 0) return;

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ids,
    addRules: [],
  });
  console.log("[Guardian DNR] Bypasses limpos:", ids.length);
}
