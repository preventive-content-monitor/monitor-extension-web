# monitor-extension-web — Extensão Chrome do GuardIAn

Extensão Chrome (Manifest V3) instalada no navegador do **dependente** (criança/adolescente). Captura eventos de navegação e os envia para a nuvem para classificação por IA.

---

## Visão Geral

| Atributo | Valor |
|----------|-------|
| Manifest | V3 (Manifest Version 3) |
| Plataforma | Google Chrome |
| Modo de instalação | Desenvolvedor (`chrome://extensions` → "Carregar sem compactação") |
| Backend e eventos | `https://<EC2-IP>` (Spring Boot via nginx) |

> O deploy do frontend ajusta `src/shared/constants.js` para o IP HTTPS publicado.

---

## Estrutura de Arquivos

```
monitor-extension-web/
├── manifest.json                   ← Declaração da extensão (MV3)
├── assets/                         ← Ícones da extensão
└── src/
    ├── background/
    │   ├── serviceWorker.js        ← Service Worker principal (coordenação)
    │   ├── apiClient.js            ← Chamadas autenticadas ao backend
    │   ├── deviceIdentity.js       ← Identidade do dispositivo e enrollment
    │   ├── eventQueue.js           ← Fila local de eventos (drena a cada 30s)
    │   ├── policyStore.js          ← Cache local da política (TTL 15s)
    │   ├── policySync.js           ← Sincroniza política com o backend
    │   └── dnrRules.js             ← Aplica bloqueios via DeclarativeNetRequest
    ├── content/
    │   ├── pageObserver.js         ← Detecta navegações e mudanças de conteúdo
    │   ├── searchDetector.js       ← Detecta termos pesquisados em buscadores
    │   └── sanitizer.js            ← Sanitiza dados antes de enviar
    ├── blocked/
    │   ├── blocked.html            ← Página exibida quando site é bloqueado
    │   └── blocked.js              ← Lógica da página de bloqueio
    ├── options/
    │   ├── options.html            ← Tela de configuração da extensão
    │   ├── options.css             ← Estilos da tela de opções
    │   └── options.js              ← Lógica: login, enrollment, configurações
    ├── rules/
    │   └── rules.json              ← Regras DNR estáticas iniciais
    └── shared/
        ├── constants.js            ← URLs e constantes do deploy
        ├── types.js                ← Tipos e estruturas de dados compartilhados
        └── utils.js                ← Utilitários compartilhados
```

---

## Fluxo de Funcionamento

### 1. Instalação e Configuração

1. Na landing do GuardIAn, abra **Instalar extensão** e baixe o pacote ZIP
2. Extraia o ZIP em uma pasta permanente do computador
3. Instale a extensão em modo desenvolvedor no Chrome do dependente
4. Clique no ícone do Guardian na barra do navegador: a janelinha abre diretamente, sem procurar **Opções**. Se não estiver visível, clique na peça de quebra-cabeça, encontre **Guardian - Proteção Familiar** e fixe o ícone na barra.
5. Faça login com as credenciais do responsável (`email` + `senha`)
6. Insira o **código de vínculo** gerado no dashboard (válido 5 minutos)
7. Clique em **Conectar**. A extensão associa este navegador ao dependente e mostra o nome em **Protegendo**.

O login da extensão concede apenas uma autorização temporária para vincular,
não uma sessão do painel. Depois do vínculo, a extensão descarta essa
autorização e guarda somente uma credencial limitada ao próprio dispositivo.
Um perfil do navegador protege um dependente por vez.

A página completa de configuração continua disponível para compatibilidade e
ajustes avançados, mas não é necessária para o fluxo normal.

**Atualização obrigatória de instalações antigas:** baixe o novo ZIP, extraia os
arquivos na pasta da extensão já instalada e clique em **Recarregar** em
`chrome://extensions` ou `edge://extensions`. Só então, abra o ícone e entre
com a conta do responsável para reautorizar o dispositivo existente. Não crie
um vínculo duplicado. Não digite sua senha na versão antiga, que usava HTTP.

### 2. Captura de Eventos

- `pageObserver.js` detecta cada navegação (mudanças de URL e título)
- `searchDetector.js` identifica termos pesquisados em Google, Bing, YouTube, etc.
- Eventos são enfileirados localmente em `eventQueue.js`

### 3. Envio de Eventos (assíncrono)

A cada ~30 segundos, `serviceWorker.js` envia a fila ao backend e só remove os
eventos após uma resposta bem-sucedida:

```
POST https://<EC2-IP>/api/eventos/lote
Content-Type: application/json
Authorization: Bearer <credencial-do-dispositivo>

{
  "dispositivoId": "<uuid>",
  "eventos": [
    { "url": "youtube.com", "titulo": "...", "ocorridoEm": "..." }
  ]
}
```

### 4. Sincronização de Política

`policySync.js` consulta a política do dispositivo a cada 15 segundos:

```
GET https://<EC2-IP>/api/politica/atual?dispositivoId=<uuid>
Authorization: Bearer <credencial-do-dispositivo>
```

A política contém as regras do dependente vinculado.

### 5. Bloqueio de Sites (DNR)

`dnrRules.js` aplica os bloqueios via Chrome Declarative Net Request (DNR):

- **Domínios inteiros** (ex: `pornhub.com`) → regra `requestDomains`
- **URLs específicas** com path (ex: `youtube.com/watch?v=ID`) → regra `regexFilter`

Quando o bloqueio é ativado, o usuário é redirecionado para `blocked.html`.

---

## URLs e Constantes (`src/shared/constants.js`)

| Constante | Uso |
|-----------|-----|
| `API_BASE_URL` | Base HTTPS para auth, política, vínculo e eventos |
| `EVENT_TYPES` | `NAVIGATION`, `BLOCK_ATTEMPT`, `PERMISSION_REQUEST` |
| `POLICY_MODES` | `BLOCK`, `WARN`, `EDUCATE` |
| `RISK_THRESHOLDS` | `LOW=30`, `MEDIUM=50`, `HIGH=70`, `CRITICAL=90` |

---

## Instalação (Modo Desenvolvedor)

```
1. Abra chrome://extensions
2. Ative "Modo desenvolvedor" (canto superior direito)
3. Clique em "Carregar sem compactação"
4. Selecione a pasta: monitor-extension-web/
5. A extensão aparece na barra do Chrome
```

> Se o IP mudar, emita um certificado para o novo IP, publique novamente o
> frontend e recarregue a extensão em `chrome://extensions`.

---

## Dependências de Infraestrutura

| Recurso | Função |
|---------|--------|
| EC2 pública (Spring Boot + nginx) | Autenticação, vínculo, eventos e políticas |
| MySQL privado | Persiste contas, sessões, dispositivos, eventos e políticas |
