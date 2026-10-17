# Hispace

Chat and voice with your friends. One central server holds the accounts and messages. Everyone signs in, adds friends by username, and talks. No server addresses, invite codes or hosting for your friends to deal with.

## How people use it
1. Open the Hispace app (or the website at your server address) and create an account.
2. **Friends > Add friend**, type your friend's username, send the request.
3. They accept, and you can message and voice-call each other. Optional group servers with text and voice channels are in the left bar (the + button).

## Run the central server (you do this once)
The server stores everything in one folder (`DATA_DIR`). It needs to be always on and reachable from the internet over HTTPS (browsers only allow microphone use on HTTPS).

**Option A: a small VPS (recommended).** Any cheap Linux VPS works, as does Oracle's free tier. Point a domain at it, put your domain into `docker-compose.yml`, then:
```
docker compose up -d
```
HTTPS is automatic. Back up the `hispace-data` volume now and then.

**Option B: Render.** Use `render.yaml`. The persistent disk requires a paid plan. On free hosting your data is wiped on restarts, so do not use it.

**Option C: your own PC for free.** Run `npm install && npm run server`, then expose port 3000 with a Cloudflare Tunnel or Tailscale Funnel. Your PC must stay on, and you need a stable address.

Environment variables: `PORT` (3000), `DATA_DIR` (./data), `TRUST_PROXY=1` when behind a proxy, `ICE_SERVERS` (JSON, for a TURN server if friends behind strict networks cannot hear each other).

## Build the Windows app
```
npm install
SERVER_URL=https://chat.example.com npm run dist     (PowerShell: $env:SERVER_URL="https://chat.example.com"; npm run dist)
```
This writes `dist/Hispace-<version>-portable.exe` with your server address built in, so friends just run it and sign in. Without `SERVER_URL` the app asks for the address once on first run.

## Notes
- Passwords are stored as scrypt hashes and sessions as hashed tokens. No secrets live in the code.
- Accounts are limited to 8 per network per hour and logins are rate limited.
- Data is a single JSON file (`hispace-data.json`), fine for groups of friends.
