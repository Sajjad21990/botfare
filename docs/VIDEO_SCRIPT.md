# BotFare demo video: voiceover script

The video is cut already (2:49). You read the lines below while the silent draft plays, then I put your voice on the final cut.

## How to record (10 minutes)

1. A quiet room with soft things around (curtains, a bed, a sofa). No fan or AC noise.
2. Phone voice memo or QuickTime (File, New Audio Recording). Hold the phone about a hand's width from your mouth, a little to the side.
3. Play `botfare-draft.mp4` on your laptop with the sound off. Start recording, wait 2 seconds, then press play on the draft.
4. Read each line when its subtitle appears. Calm and friendly, a little slower than normal talking. Smile while you read; it is audible.
5. A mistake? Pause, then repeat the whole sentence. I cut the bad take.
6. Send me the file (m4a, mp3 or wav). I line every scene up, clean the sound and export the final.

Say: x402 as "ex four oh two" · dal as "dahl" · Saffron & Salt as "saffron and salt" · gpt is never said.

## The script

| Time | Scene | Read this |
| --- | --- | --- |
| 0:00 | Title card | *(silence)* |
| 0:03 | The problem | AI agents now read the web for us. They take the recipe or the guide, and the site that wrote it gets nothing. BotFare lets any website charge AI agents a few cents a page, paid through PayPal. People still read free. |
| 0:20 | How it works | Here is one 2-cent recipe. The site sets a price. An AI agent asks for the page and gets a price quote with a free preview. It signs a 2-cent payment. BotFare checks it, and the page arrives with a signed receipt. The site keeps 95 percent, paid out through PayPal. |
| 0:42 | An AI agent pays | This is a real AI agent with a wallet funded by PayPal. I ask how to make a dal that freezes well. It reads the offers for free, picks the pages worth paying for, and pays a few cents for each one. Its limits live in code, not in the prompt. The answer cites only pages it paid for. |
| 1:08 | Check the receipt | And you don't have to trust us. Every receipt is signed by BotFare. Anyone can check it in the browser with our public key. Paid, delivered, and the same bytes the agent read. |
| 1:24 | One PayPal top-up | Agent owners top up once with PayPal. One top-up covers hundreds of pages, so PayPal's fee is paid once, not on every 2-cent page. Each agent gets its own key and budget. |
| 1:38 | The website owner | For the website, it's one line of code. The owner sets prices per section, 2 cents a recipe, 50 cents a cookbook chapter, and withdraws earnings through PayPal Payouts. |
| 1:52 | Fare Advisor | Fare Advisor is AI that reads why agents skipped a page. They called the 50-cent chapter thin, so it suggests 20 cents. Nothing changes until the owner clicks Apply. |
| 2:06 | Fare Court | If a page isn't what its preview promised, the agent can dispute it. Fare Court, an AI judge, compares the promise with what arrived. Clear cases are refunded in seconds. Close calls go to the owner. |
| 2:21 | Analytics | Every paid request shows up in an AG Studio dashboard, and the owner can ask its AI assistant which agents pay most. |
| 2:33 | Close | BotFare brings x402 to PayPal's 440 million accounts. One line of code for websites, one PayPal top-up for agents. Every bot pays its fare. |
| 2:45 | End card | Pay the fare, pal. |

## Upload

- YouTube, **Public** (Devpost needs a public video). Title: `BotFare: every bot pays its fare (PayPal AI Hackathon)`.
- Description: one line from the top of the README, then the live link `https://botfare-web.onrender.com/judge` and the repo link.
- Subtitles: upload `captions.srt` (YouTube Studio, Subtitles, Add, Upload file, With timing), so judges watching muted can follow.
- Paste the video link into Devpost and send it to me for the README.

## How the video was made

Every scene is the live site at https://botfare-web.onrender.com, recorded in a browser at 1920×1080: real agent runs, real signed receipts, real PayPal sandbox data. Waiting for the AI is fast-forwarded; nothing is mocked.
