# MailXP

**Turn the workday into a little adventure.**

MailXP is a browser-based, pixel-art office game built around quests, coworkers,
and a customizable workspace. It combines a Phaser game with a Next.js
application and a PostgreSQL-backed account and progression foundation.

> **Project status:** The office game and account/backend foundations are
> implemented. Google account connection and sign-in are supported when
> configured. Gmail synchronization, AI-powered mail analysis, real email
> actions, calendar features, and real-money or blockchain transactions are
> **not implemented**. In-game dialogue and quests use local, deterministic
> sample data; connecting Google does not make the game an email client.

## Highlights

- Explore a pixel-art office with keyboard or touch controls.
- Take on a four-job quest loop and interact with scripted office coworkers.
- Customize your character and decorate your office with items from the demo
  shop.
- Adjust sound, motion, and controls; synthesized sound effects require no
  downloaded audio.
- Create an account and use the implemented account, game-state, rewards, and
  shop APIs backed by PostgreSQL.
- Optionally configure Google OAuth for account connection and sign-in.

DraftCoin, shop purchases, and cosmetics are game progression—not currency or
financial transactions. The project does not send or read email, generate AI
replies, connect a wallet, or put anything on a blockchain.

## Tech stack

| Area | Technologies |
|---|---|
| Application | Next.js 16, React 19, TypeScript |
| Game | Phaser 3, React, HTML Canvas |
| Styling | Tailwind CSS 4 |
| Server and data | Next.js Route Handlers, PostgreSQL, Prisma 7 |
| Tests | Vitest |

## Get started

### Requirements

- Node.js 20 or newer
- npm 11 or newer
- PostgreSQL for database-backed account and API features

### Install and configure

```powershell
npm ci
Copy-Item .env.example .env
```

Edit `.env` and set `DATABASE_URL` to your PostgreSQL database. For a local
development database named `mailxp_dev`, the connection string has this shape:

```dotenv
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/mailxp_dev?schema=public"
```

Create the database if needed, then apply the committed migrations and start
the development server:

```powershell
createdb -U postgres mailxp_dev
npx prisma migrate deploy
npx prisma generate
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). If PostgreSQL is already
configured, skip the `createdb` command. The browser game can be explored
locally; database-backed features require a working `DATABASE_URL`.

### Optional Google OAuth

Google OAuth is disabled until configured. To enable account connection and
sign-in, create a Google OAuth **Web application** client, configure the
consent screen and redirect URI, and set these values in your private `.env`:

```dotenv
GOOGLE_CLIENT_ID="YOUR_GOOGLE_CLIENT_ID"
GOOGLE_CLIENT_SECRET="YOUR_GOOGLE_CLIENT_SECRET"
GOOGLE_REDIRECT_URI="http://localhost:3000/api/v1/callbacks/googleOAuth"
GOOGLE_TOKEN_ENCRYPTION_KEY="YOUR_BASE64_ENCODED_32_BYTE_KEY"
```

Generate an encryption key with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use the exact same redirect URI in Google Cloud Console. Keep the encryption
key stable for the lifetime of stored credentials; changing it makes existing
encrypted credentials unreadable. Never commit `.env` or publish real OAuth
client secrets or encryption keys. The checked-in `.env.example` contains
placeholders only.

## Development commands

```bash
npm run dev       # Start the development server
npm test          # Run the Vitest suite
npx tsc --noEmit  # Type-check the project
npm run build     # Create a production build
npm run start     # Serve the production build
```

Additional asset checks:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/validate-assets.ps1
node scripts/verify-atlas-parse.js
```

When changing the Prisma schema locally, create and apply a development
migration with `npx prisma migrate dev`.

## How to play

| Action | Keyboard | Touch |
|---|---|---|
| Move | Arrow keys or `W`, `A`, `S`, `D` | On-screen directional pad |
| Interact with office characters and objects | `E` | **Interact (E)** button |
| Open the game | Select **Play** on the title screen | Tap **Play** |
| Open or close a menu panel | Select **Menu**; `Escape` closes a panel | Tap the menu controls |

The office stays mounted while menu panels are open, so the current game state
is preserved. Sound, reduced motion, and on-screen controls can be adjusted in
Settings.

## Architecture at a glance

```text
Browser
├── Next.js / React interface
└── Phaser office game
        │
        └── Next.js API routes
              ├── Authentication and account management
              ├── Game state, preferences, events, and rewards
              ├── Demo shop and progression
              └── Optional Google OAuth connection and sign-in
                         │
                         └── PostgreSQL via Prisma
```

The Phaser game and React interface communicate through a small game bridge.
Server-side account and progression data uses PostgreSQL. The in-game demo
shop and DraftCoin should not be mistaken for real-world payments or currency.

## Project layout

| Path | Purpose |
|---|---|
| `app/` | Next.js pages, layout, and API route handlers |
| `components/` | Game shell, menus, screens, and game-to-UI integration |
| `game/` | Phaser scenes, game logic, data, audio, and local profile |
| `lib/server/` | Server-side authentication, persistence, and domain services |
| `prisma/` | Database schema and versioned migrations |
| `public/assets/mailxp/` | Game art, sprite sheets, atlases, and asset guides |
| `scripts/` | Asset generation and validation utilities |
| `docs/` | Architecture, API contract, plans, and implementation reports |

## Documentation

- [Project context and commands](./context.md)
- [Backend architecture](./docs/BACKEND_ARCHITECTURE.md)
- [Backend API contract](./docs/BACKEND_API_CONTRACT.md)
- [Frontend implementation report](./docs/PHASE_7_REPORT.md)
- [Backend implementation report: B8](./docs/B8_REPORT.md)
- [Game asset guide](./public/assets/mailxp/ASSET_GUIDE.md)

The phase plans and reports in `docs/` provide more detail on implementation
history and future work.

## Security

Do not commit secrets, credentials, private keys, or real `.env` files. The
repository ignores `.env*` while explicitly allowing the placeholder-only
`.env.example`. Before deploying, use a managed secret store, configure
production OAuth redirect URIs, and review the security and deployment
requirements for your environment.
