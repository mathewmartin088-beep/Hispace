# Deploy Hispace to Render (free, worldwide, no credit card)

## 1. Put this code on GitHub
1. Go to github.com, sign up if you don't have an account (free).
2. Click the "+" top-right -> "New repository". Name it `hispace`. Keep it Private or Public, either works. Create it (don't add a README).
3. Install **GitHub Desktop** (desktop.github.com), sign in with your GitHub account.
4. In GitHub Desktop: File -> Clone repository -> pick your new `hispace` repo -> choose a folder on your PC -> Clone.
5. Extract this zip, and copy everything INSIDE it (not the folder itself) into that cloned `hispace` folder, so `server/`, `public/`, `Dockerfile`, `package.json` etc. end up directly inside it.
6. Back in GitHub Desktop you'll see all the new files listed. Type a summary like "Initial commit", click **Commit to main**, then click **Push origin** (top bar).

## 2. Deploy on Render
1. Go to render.com, sign up free (the "Sign up with GitHub" option is fastest and links your repo automatically).
2. Click **New +** -> **Web Service**.
3. Pick your `hispace` repository.
4. Render should auto-detect the Dockerfile. If asked for settings:
   - **Instance Type:** Free
   - **Health Check Path:** `/api/ping`
5. Under **Environment**, add one variable: `TRUST_PROXY` = `1`.
6. Click **Create Web Service**. It builds for a few minutes (watch the log).
7. When it's live, Render shows your URL at the top, something like:
   `https://hispace-xxxx.onrender.com`

## 3. Send me that URL
Paste it back here and I'll bake it into the Hispace app and rebuild the installer, so your friends just open the app and sign in — no address to type.

**Note:** the free instance sleeps after 15 minutes with no traffic and takes about a minute to wake back up on the next request. Normal chat use will feel fine; the very first message after a quiet stretch will just be slow to arrive.

**Voice calls between different networks:** the server automatically gets friends a free TURN relay (Open Relay Project) as a fallback when a direct connection can't be made, so voice should now work between two different homes/networks, not just on the same WiFi. No setup needed - it's built in.
