# Accessing Yfine remotely — the secure way

Yfine is a **local-first desktop app**. There is no server, no web backend and no
HTTP port to expose: your data lives in a local SQLite database on the machine
where the app runs (optionally AES-256-GCM-encrypted at rest). That is the whole
point of the app — and it means you should **never** try to "host" Yfine behind a
domain the way you would host a web app.

> ⚠️ In particular, do **not** expose the dev preview (`pnpm dev`, Vite on
> port 1420) to the internet. It is a development server running an **in-memory
> database with fake sample data** — it will not show your real finances, and a
> Vite dev server is not hardened for public exposure.

What *does* work — without changing Yfine's privacy model — is remote access to
the **desktop where Yfine runs**. Your data never leaves that machine; you just
view and control its screen through an encrypted, authenticated channel. This
guide covers two solid setups:

1. [Cloudflare Tunnel + Cloudflare Access](#option-1--cloudflare-tunnel--access-uses-your-own-domain)
   — uses your own domain, works from any browser, protected by Zero Trust login.
2. [Tailscale](#option-2--tailscale-no-domain-needed) — even simpler, no domain
   needed, nothing ever exposed to the public internet.

Either way, keep Yfine's own **app password** enabled (Settings → Security): it
is your last line of defence, since it keeps the database encrypted at rest.

---

## Option 1 — Cloudflare Tunnel + Access (uses your own domain)

**How it works:** `cloudflared` runs on the PC where Yfine is installed and opens
an *outbound-only* connection to Cloudflare — no inbound firewall port, no
port-forwarding, nothing listening on the public internet. Cloudflare Access
(Zero Trust) sits in front and refuses everyone except you (email OTP or your
identity provider, with MFA). The screen-sharing protocol (VNC or RDP) is bound
to `localhost` only, so it is never directly reachable — not even from your LAN.

Requirements: your domain must use Cloudflare nameservers (free plan is fine;
Zero Trust is free up to 50 users).

### Step 1 — Run a screen-sharing server bound to localhost

- **Linux (X11):**
  ```sh
  x11vnc -display :0 -localhost -usepw -forever
  ```
  `-localhost` is mandatory: it binds VNC to 127.0.0.1 so only the tunnel can
  reach it. Set a VNC password with `x11vnc -storepasswd` first.
- **macOS:** System Settings → General → Sharing → **Screen Sharing** (this is a
  VNC server on port 5900). Keep the macOS firewall on; the tunnel connects via
  localhost.
- **Windows:** prefer the built-in **Remote Desktop** (RDP, Pro editions:
  Settings → System → Remote Desktop) and see the RDP variant in step 4. If you
  only have Windows Home, install TightVNC/UltraVNC and bind it to loopback only.

### Step 2 — Create the tunnel

On the machine running Yfine:

```sh
# install cloudflared: https://developers.cloudflare.com/cloudflared/
cloudflared tunnel login
cloudflared tunnel create yfine-desktop
cloudflared tunnel route dns yfine-desktop desktop.your-domain.tld
```

Create the config file (`~/.cloudflared/config.yml`, or
`/etc/cloudflared/config.yml` when running as a service):

```yml
tunnel: <TUNNEL-UUID>
credentials-file: /home/you/.cloudflared/<TUNNEL-UUID>.json

ingress:
  # VNC, reachable ONLY through Cloudflare Access — never exposed directly
  - hostname: desktop.your-domain.tld
    service: tcp://localhost:5900
  # everything else is rejected
  - service: http_status:404
```

Run it (and install it as a service so it survives reboots):

```sh
cloudflared tunnel run yfine-desktop      # test
sudo cloudflared service install          # Linux/macOS; on Windows: cloudflared service install
```

### Step 3 — Lock it down with Cloudflare Access (this is the important part)

A tunnel without an Access policy is a door without a lock. In the
[Zero Trust dashboard](https://one.dash.cloudflare.com/):

1. **Access → Applications → Add an application → Self-hosted.**
2. Application domain: `desktop.your-domain.tld`.
3. **Policy → Allow**, include: *Emails* → **only your email address(es)**.
   Nothing else. No "Everyone", no whole email domains.
4. Session duration: keep it short (e.g. 24 h or less).
5. Under the application's settings, enable **Browser rendering → VNC**.
   Cloudflare will render the VNC session directly in your browser after you
   authenticate — no client software needed on the device you're connecting from.
6. Optional but recommended: connect a real identity provider (Google, GitHub,
   Microsoft…) with MFA instead of the default email one-time PIN.

Now visiting `https://desktop.your-domain.tld` from anywhere shows a Cloudflare
login wall; after you authenticate, your desktop appears in the browser tab and
you can use Yfine as if you were sitting at the PC.

### Step 4 — RDP variant (Windows)

RDP gives a much smoother experience than VNC on Windows. Same tunnel, but:

```yml
ingress:
  - hostname: desktop.your-domain.tld
    service: rdp://localhost:3389
  - service: http_status:404
```

Create the same Access application/policy for the hostname. Browser rendering
for RDP is available on some Zero Trust plans; otherwise, on the *client*
device run:

```sh
cloudflared access rdp --hostname desktop.your-domain.tld --url rdp://localhost:2244
```

then point your RDP client (mstsc, Microsoft Remote Desktop) at
`localhost:2244`. `cloudflared` will pop the Access login in your browser and
proxy the session once you're authenticated.

### Hardening checklist

- [ ] VNC/RDP bound to **127.0.0.1 only** — verify with `ss -tlnp | grep -E '5900|3389'`
      (the local address must be `127.0.0.1`, not `0.0.0.0`).
- [ ] No router port-forwarding for 5900/3389. The tunnel is outbound-only.
- [ ] Access policy allows **only your email**; MFA enabled on the identity provider.
- [ ] The ingress ends with `http_status:404` and exposes **nothing else** —
      never add the Vite dev server (1420) or any local service you don't intend
      to publish.
- [ ] OS account has a strong password/lock screen; VNC has its own password too
      (defence in depth — Access is the real gate, but layers are cheap).
- [ ] Yfine app password is set, so the database stays encrypted at rest.
- [ ] Review Zero Trust **Logs → Access** occasionally for unexpected logins.

---

## Option 2 — Tailscale (no domain needed)

If you don't strictly need your domain for this, [Tailscale](https://tailscale.com)
is even simpler and arguably harder to get wrong: it builds a private WireGuard
mesh between your devices. Install it on the PC running Yfine and on your
phone/laptop, then connect with any VNC/RDP client to the machine's private
`100.x.y.z` address (or MagicDNS name). Nothing is ever exposed to the public
internet, there is no public hostname to attack, and screen-sharing can stay
bound to the tailnet. The free plan covers personal use.

You can keep both: Tailscale for day-to-day access, the Cloudflare setup for
browser-only access from devices where you can't install anything.

---

## Using Yfine on multiple computers instead

If what you actually want is *your data on several machines* rather than remote
control of one, install the native app on each machine and sync the database
file with a peer-to-peer tool like [Syncthing](https://syncthing.net):

- Sync the app-data directory containing `yfine.db` / `yfine.db.enc`.
- Set an app password so the synced file is the **encrypted** `yfine.db.enc`.
- Only ever have the app **open on one machine at a time** — SQLite files must
  not be written from two hosts concurrently, and Yfine decrypts to a working
  file while running. Close the app and let sync finish before switching.

Regular `.yfine` backups (Settings → Data) remain your safety net.

---

## What *not* to do

- **Don't** expose the Vite dev server (`pnpm dev`, port 1420) — fake data,
  unhardened server.
- **Don't** port-forward VNC (5900) or RDP (3389) on your router. Both are
  scanned and brute-forced constantly.
- **Don't** create a Cloudflare public hostname without an Access policy in
  front of it.
- **Don't** put the *decrypted* `yfine.db` in Dropbox/Drive-style continuous
  sync while the app is open — you risk both corruption and an unencrypted copy
  of your finances on a third-party cloud.
