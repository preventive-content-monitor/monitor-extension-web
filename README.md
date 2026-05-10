# monitor-extension-web — Extensão Chrome do GuardIAn

Extensão Chrome (Manifest V3) instalada no navegador do **dependente** (criança/adolescente). Captura eventos de navegação e os envia para a nuvem para classificação por IA.

---

## Visão Geral

| Atributo | Valor |
|----------|-------|
| Manifest | V3 (Manifest Version 3) |
| Plataforma | Google Chrome |
| Modo de instalação | Desenvolvedor (`chrome://extensions` → "Carregar sem compactação") |
| Backend auth/política | `http://<EC2-IP>` (Spring Boot via nginx) |
| Envio de eventos | `https://2o9ybf5asf.execute-api.us-east-1.amazonaws.com/prod` (API Gateway) |

> As URLs são geradas automaticamente pelo Terraform e gravadas em `src/shared/constants.js`. **Não edite `constants.js` diretamente** — edite o template `constants.js.tpl` e rode `terraform apply`.

---

## Estrutura de Arquivos

```
monitor-extension-web/
├── manifest.json                   ← Declaração da extensão (MV3)
├── assets/                         ← Ícones da extensão
└── src/
    ├── background/
    │   ├── serviceWorker.js        ← Service Worker principal (coordenação)
    │   ├── apiClient.js            ← Funções de fetch (backend + API Gateway)
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
        ├── constants.js            ← URLs e constantes (gerado pelo Terraform)
        ├── types.js                ← Tipos e estruturas de dados compartilhados
        └── utils.js                ← Utilitários compartilhados
```

---

## Fluxo de Funcionamento

### 1. Instalação e Configuração

1. Instale a extensão em modo desenvolvedor no Chrome do dependente
2. Clique no ícone da extensão → **Opções**
3. Faça login com as credenciais do responsável (`email` + `senha`)
4. Insira o **código de vínculo** gerado no dashboard (válido 5 minutos)
5. A extensão associa este Chrome ao dispositivo cadastrado e começa a monitorar

### 2. Captura de Eventos

- `pageObserver.js` detecta cada navegação (mudanças de URL e título)
- `searchDetector.js` identifica termos pesquisados em Google, Bing, YouTube, etc.
- Eventos são enfileirados localmente em `eventQueue.js`

### 3. Envio de Eventos (assíncrono)

A cada ~30 segundos, `serviceWorker.js` drena a fila e envia para o **API Gateway**:

```
POST https://2o9ybf5asf.execute-api.us-east-1.amazonaws.com/prod/events/batch
Content-Type: application/json

{
  "dispositivoId": "<uuid>",
  "eventos": [
    { "url": "youtube.com", "titulo": "...", "ocorridoEm": "..." }
  ]
}
```

O API Gateway enfileira no SQS sem resposta síncrona. O processamento (classificação IA) ocorre de forma assíncrona na Lambda.

### 4. Sincronização de Política

`policySync.js` consulta a política do dispositivo a cada 15 segundos:

```
GET http://<EC2-IP>/api/politica/atual?dispositivoId=<uuid>
```

A política contém a lista de `dominios_bloqueados` atualizada pela Lambda.

### 5. Bloqueio de Sites (DNR)

`dnrRules.js` aplica os bloqueios via Chrome Declarative Net Request (DNR):

- **Domínios inteiros** (ex: `pornhub.com`) → regra `requestDomains`
- **URLs específicas** com path (ex: `youtube.com/watch?v=ID`) → regra `regexFilter`

Quando o bloqueio é ativado, o usuário é redirecionado para `blocked.html`.

---

## URLs e Constantes (`src/shared/constants.js`)

| Constante | Uso |
|-----------|-----|
| `API_BASE_URL` | Base para auth, política e enrollment → EC2 Spring Boot |
| `EVENTS_API_URL` | Envio de eventos → API Gateway → SQS → Lambda |
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

> Após cada `terraform apply` que altere o IP da EC2, recarregue a extensão em `chrome://extensions` para que o novo `constants.js` seja aplicado.

---

## Dependências de Infraestrutura

| Recurso | Função |
|---------|--------|
| EC2 (Spring Boot + nginx) | Autenticação, enrollment, sincronização de política |
| API Gateway (`guardian-api`) | Recebe batches de eventos da extensão |
| SQS (`guardian-eventos`) | Fila assíncrona de eventos |
| Lambda (`guardian-classificador`) | Classifica URLs com OpenAI gpt-4o-mini |
| RDS MySQL | Persiste eventos, classificações e políticas |
| SNS (`guardian-alertas`) | Notifica o responsável por e-mail |
