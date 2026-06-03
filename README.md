# xbot

A crypto-themed X.com (Twitter) auto-reply bot. It polls for mentions of your
bot account, decides which ones are worth answering, generates an on-brand
reply with OpenAI, and posts it — with persistence so it never double-replies.

> **Disclaimer:** xbot is an entertainment/engagement tool. It does **not**
> provide financial advice, and its default persona is explicitly instructed
> never to recommend buying, selling, or holding any asset. See
> [Responsible automation](#responsible-automation).

---

## How it works

```
            ┌─────────────┐   poll mentions   ┌──────────────┐
            │  X (v2 API) │ ───────────────►  │   xbot       │
            │             │ ◄───────────────  │  poller      │
            └─────────────┘    post reply     └──────┬───────┘
                                                      │
              filter (own/retweet/blocked/lang/dedupe)│
                                                      ▼
                                              ┌──────────────┐
                                              │  OpenAI       │
                                              │  reply gen    │
                                              └──────────────┘
                                                      │
                                            SQLite (cursor + dedupe)
```

xbot uses **polling** (the X v2 mentions timeline), not webhooks. True
streaming webhooks (Account Activity API) require X's **Enterprise** tier;
polling works on the much cheaper **Basic** tier and is the default — and only
— supported path.

---

## Requirements

- **Node.js >= 20**
- An **X Developer account** with a **Basic** (or higher) access tier. The free
  tier does **not** grant access to the mentions timeline read endpoint.
- An **OpenAI API key**.
- A C toolchain for building the `better-sqlite3` native addon (usually already
  present; see [Troubleshooting](#troubleshooting)).

### X API tier & rate limits

| Capability | Required tier |
|------------|---------------|
| Post a tweet / reply (`POST /2/tweets`) | Basic |
| Read your mentions timeline (`GET /2/users/:id/mentions`) | Basic |
| Streaming webhooks (Account Activity API) | Enterprise |

The Basic tier has tight monthly post/read caps and per-endpoint rate-limit
windows. xbot is built around these limits:

- It honors `429` responses by waiting until the `x-rate-limit-reset` time
  before retrying (with exponential-backoff fallback).
- `POLL_INTERVAL_SEC` and `MAX_REPLIES_PER_RUN` let you stay well under your
  monthly caps. Start conservative (e.g. a 5-minute poll, 5 replies/run) and
  tune from your usage dashboard.

---

## Setup

```bash
git clone <your-fork-url> xbot
cd xbot
npm install
cp .env.example .env
# edit .env with your credentials (see the table below)
```

Create your X app credentials (OAuth 1.0a **user context**: app key/secret +
access token/secret) from the X Developer Portal, and grab your bot account's
**numeric user ID** (`BOT_USER_ID`) — not its handle.

---

## Configuration

Configuration is read from the environment (a local `.env` is loaded
automatically outside `NODE_ENV=production`) and validated at startup by
`src/config.ts`. On invalid/missing values the process fails fast with an
aggregated, **secret-free** error listing every problem.

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `X_APP_KEY` | yes | — | X app (consumer) API key. |
| `X_APP_SECRET` | yes | — | X app (consumer) API secret. |
| `X_ACCESS_TOKEN` | yes | — | OAuth 1.0a access token for the bot account. |
| `X_ACCESS_SECRET` | yes | — | OAuth 1.0a access token secret. |
| `BOT_USER_ID` | yes | — | Numeric user ID of the bot account (used to read mentions and to skip its own tweets). |
| `OPENAI_API_KEY` | yes | — | OpenAI API key. |
| `OPENAI_MODEL` | no | `gpt-4o-mini` | Chat model used to generate replies. |
| `OPENAI_TEMPERATURE` | no | `0.7` | Sampling temperature, `0`–`2`. |
| `POLL_INTERVAL_SEC` | no | `300` | Seconds between mention polls. |
| `MAX_REPLIES_PER_RUN` | no | `5` | Cap on replies posted per poll cycle. |
| `DRY_RUN` | no | `false` | When true, generate replies but **do not** post them. Accepts `true/false`, `1/0`, `yes/no`, `on/off`. |
| `BLOCKLIST` | no | — | Comma-separated user IDs and/or `@handles` to never reply to. |
| `ALLOWED_LANGUAGES` | no | — | Comma-separated BCP-47 codes (e.g. `en,es`). Empty = allow all. |
| `PERSONA_PROMPT` | one of these two* | — | Inline persona system prompt. |
| `PERSONA_PROMPT_PATH` | one of these two* | — | Path to a persona prompt file (e.g. `prompts/persona.md`). |
| `DATABASE_PATH` | no | `./xbot.db` | SQLite file for the cursor + reply-dedupe store. |

\* Exactly one of `PERSONA_PROMPT` or `PERSONA_PROMPT_PATH` must be set. If you
want the bundled default voice, point `PERSONA_PROMPT_PATH` at
[`prompts/persona.md`](prompts/persona.md).

> **Never** commit real secrets. `.env` is git-ignored; only `.env.example`
> (with empty values) is tracked.

---

## The persona

The bot's voice is a configurable **system prompt**. The bundled default lives
in [`prompts/persona.md`](prompts/persona.md): a knowledgeable, witty,
crypto-native voice that is explicitly forbidden from giving financial advice,
making price predictions, or promising returns.

To customize, either edit `prompts/persona.md`, point `PERSONA_PROMPT_PATH` at
your own file, or set `PERSONA_PROMPT` inline. Replies are always constrained to
X's 280-character limit (by instruction and a hard truncation fallback).

---

## Running

### Local development

```bash
# hot-reloading dev server
npm run dev
```

### Dry run (no posting)

Validate end-to-end behavior — polling, filtering, generation — without ever
posting to X:

```bash
DRY_RUN=true npm run dev
```

This is the recommended first run against a real account: you'll see the
replies xbot *would* send in the logs without touching the timeline.

### Production build

```bash
npm run build   # compile TypeScript to dist/
npm start       # node dist/index.js
```

### Docker

A minimal image (note: `better-sqlite3` needs a build toolchain in the builder
stage):

```dockerfile
# Dockerfile
FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY prompts ./prompts
VOLUME ["/data"]
ENV DATABASE_PATH=/data/xbot.db
CMD ["node", "dist/index.js"]
```

```bash
docker build -t xbot .
docker run --rm --env-file .env -v "$PWD/data:/data" xbot
```

Mount a volume for `DATABASE_PATH` so the cursor and reply-dedupe history
survive restarts — otherwise the bot may re-reply to old mentions.

---

## Responsible automation

Running an automated reply bot on X carries real obligations:

- **Follow X's automation rules.** Per the
  [X Automation Rules](https://help.x.com/en/rules-and-policies/x-automation),
  bulk, aggressive, spammy, or duplicative replies can get your account
  suspended. Keep `MAX_REPLIES_PER_RUN` modest, don't reply to the same user
  repeatedly, and don't @-mention people who didn't engage with you.
- **Identify the account as automated** where appropriate (e.g. the profile
  label for automated accounts).
- **No financial advice.** The default persona refuses to give buy/sell/hold
  recommendations, price targets, or guarantees of returns. If you customize
  the persona, keep that guardrail — and consider adding a standing disclaimer.
  Generated content is for entertainment only and is **not** investment advice.
- **You are responsible** for everything the bot posts. Test with `DRY_RUN=true`
  before going live, and monitor its output.

---

## Troubleshooting

**`better-sqlite3` fails to install / "was compiled against a different Node
version".**
The native addon must build for your Node ABI. Ensure a C/C++ toolchain is
present, then rebuild:

```bash
# macOS: xcode-select --install
# Debian/Ubuntu: sudo apt-get install -y python3 make g++
npm rebuild better-sqlite3
```

If you switched Node versions, delete `node_modules` and reinstall.

**`401 Unauthorized` / auth errors when posting.**
- Confirm you're using OAuth 1.0a **user-context** credentials (all four of
  `X_APP_KEY`, `X_APP_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`).
- Your app must have **Read and Write** permissions. If you changed permissions
  *after* generating the access token, **regenerate** the access token/secret.
- Make sure the access token belongs to the same account as `BOT_USER_ID`.

**`403 Forbidden` reading mentions / "client-not-enrolled".**
Your project isn't on a tier that grants the mentions endpoint. Attach the app
to a **Basic** (or higher) project in the X Developer Portal.

**`429 Too Many Requests`.**
xbot already backs off and retries until the rate-limit window resets. If you
see this constantly, increase `POLL_INTERVAL_SEC` and/or lower
`MAX_REPLIES_PER_RUN`; you may be near your monthly cap.

**The bot replied to the same tweet twice.**
The dedupe/cursor state lives in the SQLite file at `DATABASE_PATH`. If that
file is ephemeral (e.g. an unmounted container path), state is lost on restart.
Mount a persistent volume.

---

## Project layout

```
src/
  config.ts          # zod-validated env config (fail-fast)
  ai/generate.ts     # OpenAI reply generation + persona loading
  x/client.ts        # twitter-api-v2 wrapper (mentions + reply, rate-limit retry)
  pipeline/filter.ts # pure mention filter (own/retweet/blocked/lang/dedupe)
  store/db.ts        # SQLite cursor + reply-dedupe persistence
  index.ts           # entrypoint
prompts/
  persona.md         # default crypto persona system prompt
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run with hot reload (tsx). |
| `npm run build` | Type-check & compile to `dist/`. |
| `npm start` | Run the compiled build. |
| `npm run lint` | ESLint over `src/`. |
| `npm run format` | Prettier-format `src/`. |
