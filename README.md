<p align="center"><img src="public/logo.svg" width="110" alt="Call a Burger logo"></p>

# Call a Burger

Scripted outbound calls with a **male or female voice** and a **live transcript in Telegram**.

**Accounts.** Anyone can open the homepage and draft a call. To place one, they need an account, and each account keeps its own saved balance, phone number and call history.

- **Create account / Sign in** (header buttons → `login.html`): email, password, and the name calls come from, protected by a **captcha** (Cloudflare Turnstile). Passwords are stored hashed, never as plain text.
- **Continue with Telegram** is offered on the same page, and inside Telegram the app (Mini App) signs people in automatically.
- An email account can tap **Connect Telegram** to get live transcripts. That also links their Telegram, so opening the bot later signs them into the **same** account with the same balance.

**Calls are locked until the balance is topped up.** The **💰 Top up** button sits in the header and opens the crypto checkout pop-up. Until the balance covers a call, the call button reads *Top up to call*.

Every call streams to the user's Telegram line by line as it happens. That's their private chat with the bot, linked automatically when they sign in, plus any groups they add. You can also set an admin group that sees every call from every user.

```
Open @YourBot ─► tap Start / menu ─► app opens inside Telegram (signed in)
   ─► 💰 Top up with crypto ─► write script, pick voice ─► Place call
   ─► Twilio dials from the user's own number ─► live transcript ─► user's Telegram (+ admin group)
```

### Bot commands (set up automatically)
| Command | What it does |
|---|---|
| `/start`, `/app` | Opens the app inside Telegram |
| `/topup` | Opens straight to the Top up checkout |
| `/balance` | Shows balance, minutes left and the user's number |
| `/stop` | Stops transcripts in that chat |

## Folder layout

| File | What it is |
|---|---|
| `server.js` | Telegram sign-in, the bot, billing, numbers, calls, Twilio and payment webhooks |
| `public/index.html` | The app (website and Telegram Mini App): call form, Top up pop-up, Telegram panel, live transcript, recent calls |
| `public/logo.svg` | The burger-on-a-phone logo (the original artwork everything else is made from) |
| `public/favicon.ico`, `favicon-32.png` | Browser tab icons |
| `public/apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | Home-screen app icons (iPhone and Android "Add to Home Screen") |
| `public/social.jpg` | Link-preview card shown when the site is shared in Telegram, iMessage, X or Facebook; also the banner on the bot's welcome message |
| `public/bot-avatar.jpg` | Profile picture for your Telegram bot (upload with @BotFather `/setuserpic`) |
| `public/thumb.jpg` | Artwork shown on call recordings in Telegram |
| `.env.example` | Every setting, with comments — copy to `.env` |
| `package.json` | Dependencies (Node 18+) |
| `public/login.html` | Create account / Sign in page with captcha |
| `data/db.json` | Created automatically: accounts, **balances**, numbers, payments, call history. This is your customers' money; keep it on persistent storage (see below), back it up, and never commit it. |

## Setup

You only need **one Telegram bot**. No second Telegram account is required, and you create the bot from your own account.

1. **Create the bot.** Message `@BotFather` → `/newbot` → name it *Call a Burger* → pick a username (e.g. `CallABurgerBot`) → copy the token.
   - **Bot picture:** send `/setuserpic`, pick your bot, and upload `public/bot-avatar.jpg`. Telegram only lets bot owners set this through @BotFather; the app can't do it for you.
   - **Description:** `/setdescription` with a line like *"Scripted calls with live transcripts. Tap Start."*, and `/setdescriptionpic` with `public/social.jpg` so new visitors see the logo before pressing Start.
2. **Allow website sign-in.** In @BotFather, send `/setdomain`, pick your bot, and enter your site's domain (e.g. `callaburger.com`). Without this, the **Sign in with Telegram** button on the website won't appear. The in-Telegram app doesn't need it.
3. **Twilio.** Create an account, upgrade it from the trial, and copy your Account SID and Auth Token.
4. **Configure.** Copy `.env.example` to `.env` and fill it in. `PUBLIC_BASE_URL` must be a public **HTTPS** address (a host like Railway or Render, or `ngrok http 3000` for testing); Telegram only opens Mini Apps over HTTPS.
5. **Run.**
   ```bash
   npm install
   npm start
   ```
   On startup the server connects to your bot and sets everything up automatically: the webhook, the **menu button** that opens the app inside Telegram, and the `/` command list. The log should show `Telegram bot @YourBot connected`.
6. **Try it:** open your bot in Telegram, tap **Start**, then the **Call a Burger** button.

## Your admin group (sees every call)

1. Create the Telegram group and add your bot to it.
2. Send any message in the group, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the group's `chat.id` (starts with `-100`).
   If nothing appears, the server's webhook is active, so temporarily stop the server and run `https://api.telegram.org/bot<TOKEN>/deleteWebhook`. Get the ID, then restart (the webhook re-registers itself).
3. Put the ID in `ADMIN_TELEGRAM_CHAT_ID`. Admin messages also include which user placed the call.

## Where transcripts go

When someone signs in (in Telegram or through the website's Telegram button), their **private chat with the bot is linked automatically**. That chat receives their transcripts, top-up confirmations, low-balance warnings and voicemails.

To share with a team, they tap **Also send to a group** in the app and pick a group in Telegram (the link expires after 15 minutes). A user can remove any chat from the app. Sending `/stop` in a chat also disconnects it, and if the bot is kicked or blocked, the chat is unlinked automatically.

## What shows up in Telegram

```
📞 Call started — number, voice, call ID, full script
🔔 Ringing
✅ Answered
🤖 Caller (bot): Hello, this is an automated call from Hickory Burger Co. This call is recorded.
🤖 Caller (bot): Your order is ready.
👤 Recipient: Okay, thanks.
🏁 Call ended — Duration: 21s · Charged $1.00 · Balance $9.00
🎙 Call recording — to +1828…  (audio file, plays right in Telegram)
```

## How a call works

1. The customer types a script, picks **Male** or **Female**, and presses **Place call**.
2. Twilio dials from the customer's own number and reads the script in that voice. Then it keeps the line open (*Listen after script*, default 15 seconds) to hear the reply.
3. **Both sides are transcribed live.** What the bot says is labeled *Caller (bot)*; everything the other person says back is labeled *Recipient*.
4. The **🔴 Live call** screen opens automatically. It shows the call timer and each line as it's spoken, including words still in progress. Every finished line also goes to Telegram.
5. After hang-up, the **recording** (an MP3) is sent to the customer's Telegram, then deleted from Twilio. Telegram becomes the only copy.

### Recording
- On by default (`RECORD_CALLS`), but only for customers with a Telegram chat connected, since that's where the recording goes.
- When a call is recorded, the opening line adds **"This call is recorded."** Some states (e.g. California, Florida, Pennsylvania, Washington) require everyone on the call to know it's being recorded. Keep this line.
- Twilio charges about $0.0025/min to record. The file is deleted from Twilio right after delivery, so you don't pay storage. If delivery fails, it's retried every minute until the conversation's keep time runs out, then deleted anyway.

### Only the latest conversation, for one hour
- The app keeps **only each customer's most recent conversation**. Starting a new call wipes the previous transcript immediately.
- The latest conversation is **deleted 1 hour after hang-up** (`KEEP_CONVERSATION_MINUTES`). The Live call screen shows a countdown.
- What's deleted: the script, the transcript, and any recording not yet delivered. What's kept: the number dialed, the duration and the cost, so balances and payment history still add up.
- Telegram keeps its copy of the transcript and recording for as long as the customer wants. The app's deletion doesn't touch Telegram.

## Billing: prepaid minutes, loaded with crypto

Users keep a dollar balance and top it up with crypto. Each call is charged **per started minute of connected time** (`PRICE_PER_MINUTE`, default $1.00). A 75-second call is billed as 2 minutes. Top-ups start at $10 (`MIN_TOPUP`), which buys 10 minutes.

**What protects the balance:**
- **Before a call:** the app estimates its length from the script (about 150 words a minute, plus the intro and listening time). If the balance can't cover that, the user sees *Add funds* instead of a call.
- **During a call:** each call is hard-capped at the minutes the balance can pay for (Twilio `timeLimit`), so a balance can never go negative. Each account can run only one call at a time.
- **After a call:** the charge is applied once, when the call ends. Unanswered, busy and failed calls cost nothing. The user's Telegram gets the cost and the new balance, plus a warning when the balance is low.
- **Ledger:** every top-up, charge and manual adjustment is recorded, and the user sees the latest entries in the app. Chatting `/balance` to the bot shows the balance in Telegram.

### Phantom wallet: payments straight to you (recommended)

Customers pay **USDC on Solana** directly into your Phantom wallet using Solana Pay, with no processor in the middle and no processing fee. Only the network fee applies, which is a fraction of a cent and paid by the customer.

**Setup:** open Phantom, tap your account name at the top, copy your **Solana** address, and put it in `SOLANA_RECEIVE_ADDRESS`. That's the only setting. Only ever use the *public* address; never put your recovery phrase or private key anywhere.

**How it works**
1. In **Top up**, the customer picks an amount and **Phantom**. They get a QR code and an **Open in Phantom** button.
2. They scan the code with Phantom (or tap the button on their phone) and approve the payment.
3. Each request carries a unique reference key. The server finds that payment on the Solana blockchain and checks it's the right amount of USDC to your address. Then it credits the balance, usually within seconds, and sends a Telegram confirmation. A background check catches the payment even if the customer closes the app.
4. If someone sends the wrong amount, nothing is credited automatically. Your admin group gets an alert with a Solscan link so you can credit them by hand with `/api/admin/credit`.

**Notes**
- The default public Solana RPC is rate-limited. Once you have real traffic, get a free RPC URL from a provider like Helius or QuickNode and put it in `SOLANA_RPC_URL`.
- Customers need USDC on Solana in their wallet. Phantom lets them buy or swap into it, and any Solana Pay wallet (Solflare, Backpack) works too.
- Payment requests stay open for 60 minutes.

### Bitcoin: payments straight to your wallet

Customers can also pay **BTC** directly to your Native SegWit address (`BITCOIN_RECEIVE_ADDRESS`, already set to your Phantom Bitcoin address). There's no processor and no processing fee; the customer pays the Bitcoin network fee.

**How it works**
1. The customer picks an amount and **Bitcoin**. The app quotes it in BTC at the live price from mempool.space and adds a few random sats, worth at most about 25¢. That makes every request's amount unique, which is how a payment to your single address is matched to the right person.
2. They scan the QR code or tap **Open in wallet** and send that exact amount **within 30 minutes**.
3. As soon as the payment appears on the network, they get a Telegram message saying it's been seen. After 1 confirmation (usually 10–30 minutes; set `BITCOIN_CONFIRMATIONS` higher for more safety on large amounts), the balance is credited and they're notified.

**Things to know**
- **The exact amount matters.** If a customer sends a different amount, or their wallet subtracts the fee from the amount sent, it can't be matched automatically. The money still reaches your wallet. Look it up on mempool.space and credit them by hand with `/api/admin/credit`.
- A payment that's seen but still not confirmed after a day is flagged to your admin group.
- All payments go to one address, so anyone with that address can see its payment history on the blockchain. That's normal for a public receiving address, but don't use it for anything you want kept private.

### Crypto processors (optional, for other coins)

To accept Bitcoin, ETH and other coins as well, add NOWPayments. In its dashboard you can set your **Phantom address as the payout wallet** (choose SOL or USDC on Solana), so those payments land in Phantom too.

| | NOWPayments | Stripe stablecoins |
|---|---|---|
| Coins | Bitcoin, ETH, USDT, SOL, LTC and 300+ others | USDC (Ethereum, Solana, Polygon, Base), USDP, USDG |
| You receive | Crypto to your wallet, or auto-converted | US dollars in your Stripe balance |
| Who can use it | Most businesses | US businesses (EU and others in preview), approved by Stripe |

**NOWPayments setup**
1. Create an account at nowpayments.io and add the wallet where you want to receive payouts.
2. Under **Settings → Payments**, create an API key and set an **IPN secret key**.
3. Put both in `.env`. The callback URL is sent with each invoice automatically (`<PUBLIC_BASE_URL>/webhooks/nowpayments`).
4. Optional: set `NOWPAYMENTS_SANDBOX=true` with a sandbox key to test without real coins.

**Stripe setup**
1. In the Stripe Dashboard under **Settings → Payment methods**, request **Stablecoins and Crypto** and wait for approval.
2. Add a webhook endpoint at `<PUBLIC_BASE_URL>/webhooks/stripe` for these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`.
3. Put the secret key and the webhook signing secret in `.env`.

**How a top-up works**

The user picks an amount and a coin option and is sent to the processor's secure checkout. When they come back, the app shows *Waiting for your crypto payment to confirm…* until the blockchain confirms. The balance is credited only from the processor's **signed webhook**, never from the browser, and each payment is credited exactly once even if the webhook repeats. If someone underpays a NOWPayments invoice, they're credited for what actually arrived.

**Manual credits:** accounts listed in `ADMIN_EMAILS` or `ADMIN_TELEGRAM_IDS` can add or remove credit for refunds or comps. `user` can be the customer's email, Telegram ID or @username. Use a negative amount to remove credit. The user gets a Telegram message either way:
```bash
curl -X POST <PUBLIC_BASE_URL>/api/admin/credit -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <your session token>' -d '{"user":"@theirusername","amountCents":500,"note":"Refund"}'
```

**Your cost vs. what you charge (US calls, checked Oct 2026 — re-check twilio.com/voice/pricing/us):**

| Per minute | Your cost |
|---|---|
| Twilio outbound call | $0.014 |
| Real-time transcription | $0.027 (up to $0.054 if both sides are billed) |
| Neural voice (≈900 characters spoken per minute) | ≈ $0.03 |
| **Worst case** | **≈ $0.10** |

Fixed costs: $1.15/month for a local Twilio number. On top of that, the processors take a small fee per top-up. At $1.00/min you keep about $0.90 per minute, and a $10 top-up costs you roughly $1 in call costs.

## Dedicated phone numbers (one per account)

Every paying account gets **its own Twilio number**, and all of its calls come from it, so recipients always see the same caller and can call back.

- **When:** as soon as a customer's **first top-up** lands, the app buys their number and they see it right away in the app and in Telegram. It isn't bought at sign-up, because each number costs you about $1.15/month from day one and free sign-ups who never pay would run up that bill. If buying fails at top-up time, it's retried on their first call.
- **Area code:** users can set a preferred area code (like 828) in the app before their first call. If none is available there, they get a US local number.
- **Cost:** `NUMBER_MONTHLY_FEE` (default $2.00) comes out of the balance on day one and every 30 days after. Twilio charges you about $1.15/month per local number.
- **Missed renewals:** if the balance can't cover a renewal, the user is warned in Telegram and the number shows *Renewal due* in the app. Calls are paused until they add funds, and after `NUMBER_GRACE_DAYS` (default 7) the number is released back to Twilio so you stop paying for it.
- **Callbacks:** when someone calls the number back, they hear *"You've reached [caller name]. Please leave a message after the tone."* The user gets an *Incoming call* alert in Telegram, then the voicemail transcribed (up to 2 minutes; Twilio charges per transcribed minute).
- Set `DEDICATED_NUMBERS=false` to go back to one shared number (`TWILIO_FROM_NUMBER`) for everyone.

**Twilio account checklist for numbers**
- **Upgrade from the trial.** Trial accounts can hold only one number and only call verified phones.
- **Add your business profile in Twilio's Trust Hub** and register for SHAKEN/STIR. Your numbers then carry a verified caller attestation, so calls are less likely to be labeled *Spam Likely*. Branded caller name (CNAM) is a further option.
- As the platform grows, Twilio recommends a **subaccount per customer**. That keeps each customer's numbers and usage separate, and one bad actor can't affect everyone else's reputation.

## Where the logo appears

Everything is generated from `public/logo.svg`:
- **Site:** the header and the login page draw the logo straight into the page, so it shows even if image files fail to load. It also appears on the sign-in and Top up pop-ups.
- **Browser tab and home screen:** the favicons, the Apple touch icon, and the app manifest (`/manifest.webmanifest`) for "Add to Home Screen".
- **Link previews:** sharing the site shows the `social.jpg` card. The server fills in your real address (`PUBLIC_BASE_URL`) automatically, because previews need a full URL.
- **Telegram:** the welcome message after **Start** carries the banner (it needs the site to be live on HTTPS; otherwise it falls back to plain text), and call recordings carry the logo as artwork. The bot's own profile picture and description picture are set once, by you, in @BotFather (see Setup).

If you change the logo, replace `logo.svg` and regenerate the PNGs at the same sizes.

## Settings worth knowing

- `DAILY_CALL_LIMIT` — calls per user per day (default 20).
- `ANNOUNCE_CALLER` — every call opens with "Hello, this is an automated call from *name*." Each user sets that name at signup and can change it in the app. Keep this on (see Compliance).
- `VOICE_FEMALE` / `VOICE_MALE` — any Amazon Polly voice Twilio supports.

## Security

- **Email accounts:** passwords are hashed with scrypt and never stored or logged in plain text. Create account and Sign in both require a passing captcha and are rate-limited per IP. A failed sign-in says "wrong email or password" without revealing whether the email exists.
- **Telegram sign-in can't be faked.** Telegram signs every login (Mini App `initData`, and the Login Widget's hash) with your bot token. The server checks that signature and rejects logins older than 24 hours.
- Sessions last 30 days, as an HttpOnly cookie on the website or a bearer token inside Telegram. The API accepts JSON only, which blocks cross-site form posts.
- **Not built yet: "Forgot password."** It needs an email service such as Resend or Postmark to send reset links. Until then, a customer who linked Telegram can still get in through Telegram.

## Keeping balances safe when hosted

Accounts and balances are saved to `data/db.json` immediately on every change, and they survive restarts. Most hosts, though (Railway, Render, Fly), **wipe the app's files on every redeploy**, which would erase every customer's balance. Before launch:
- **Railway:** add a **Volume** to the service, mount it at `/data`, and set `DATA_DIR=/data`.
- **Render:** add a **Persistent Disk** mounted at `/data` and set `DATA_DIR=/data`.
- Back up `db.json` regularly, for example with a daily download. If you outgrow a single file, the next step is a hosted database like Supabase.
- Twilio webhooks are signature-checked, and the Telegram webhook requires a secret only Telegram knows.
- Users only ever see their own calls and transcripts.

## Compliance

Automated / artificial-voice calls are regulated. In the US, the TCPA requires the recipient's prior express consent (prior **written** consent for marketing), and the call must identify who is calling at the start; `ANNOUNCE_CALLER` handles that last part. Some states require every party's consent before a call is transcribed, so consider adding "this call may be transcribed" to scripts. The app makes users confirm consent before every call. I'm not a lawyer, so check what applies to how you'll use it.

## Testing locally without real calls

Set `TELEGRAM_MOCK=true` and `VALIDATE_TWILIO_SIGNATURE=false` to log Telegram messages to the console instead of sending them.

## Notes on crypto

Selling prepaid call credit for crypto is generally treated like any other sale of your own service, but crypto income has tax-reporting rules, and refunds go back as crypto. Balances are credit for your service, not withdrawable money; say so in your terms. I'm not a lawyer or accountant, so confirm what applies to your business.
