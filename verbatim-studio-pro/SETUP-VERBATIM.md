# Verbatim Studio — Setup (Roman Urdu, short steps)

## Pehli dafa setup (Windows)

1. Naya ZIP extract karo — **purana folder use mat karo**.
2. Folder mein `setup.bat` par double-click karo.
   - Node.js nahi hai to pehle https://nodejs.org se LTS install karo.
   - FFmpeg nahi hai to nayi PowerShell mein chalao:
     `winget install Gyan.FFmpeg`
     Phir PowerShell band karke dobara kholo.
3. `run.bat` par double-click karo.
4. Browser mein kholo: **http://localhost:3000**

## API key — Groq Free (pehle se daal di gayi hai)

- **Groq Free ab default hai** — aapki Groq key `.env.local` file mein daal di gayi hai, dobara daalne ki zaroorat nahi. Bina card ke, ~8 ghante audio/day free.
- Aapki Gemini API key bhi `.env.local` mein hai (backup). Server Groq key ho to Groq use karta hai, warna Gemini.
- **Zaroori:** `.env.local` (aur `.env`) ko kabhi client ko mat bhejo, na ZIP mein share karo. Ye file sirf aapke computer ke liye hai.
- Key badalni ho to app ke andar **Auto Clips > Change Key > Groq (Free)** se paste kar do — restart ki zaroorat nahi. **Auto / Groq / Gemini** buttons se provider bhi badla ja sakta hai.
- Upar Auto Clips mein **"Groq Free connected"** green nazar aana chahiye. Agar red ho to key check karo.
- Groq key free mein yahan banti hai: console.groq.com → API Keys → Create API Key (key `gsk_...` se shuru hoti hai).

## Auto Clips — kaise use karein (easy flow)

1. **Media Tools > Auto Clips** kholo.
2. 1 tap preset chuno:
   - **Viral Reel** — 9:16, bold ALL-CAPS captions, pro banner heading (TikTok / Reels / Shorts)
   - **Podcast Highlight** — 1:1 square, lower-third captions
   - **YouTube HD** — 16:9, cinema captions
3. Video upload karo, language chuno, **Find Best Clips & Generate Captions** dabao.
   - Agar video pehle transcribe ho chuki hai to **"Reuse Existing Transcript"** chuno — dobara transcribe nahi hoga, clips foran milenge.
4. Har clip par **Hook score /100** aur **BEST** badge dekho — sab se strong clip pehle nazar aayega.
5. Title edit karo, start/end theek karo, captions edit karo.
6. **Render All** dabao — ab 2 clips aik saath render hote hain (pehle aik aik karke hote the). **Stop** se beech mein roka bhi ja sakta hai.
7. **Download Captioned MP4** se clip download karo. **Clip List (.txt)** se saari titles + timing aik file mein mil jati hai.

## Kya improve hua hai (is version mein)

- **API key:** `.env.local` + `.env` mein daal di, server `.env.local` load karta hai, aur app ke andar key change karne ka option hai.
- **Auto-clip fast:** lambi videos mein ab blind sampling nahi — hook score se best lines chuni jati hain, taake best moment cut na ho. Gemini kam clips de to local scoring se baqi clips bhar diye jate hain (extra AI call nahi).
- **Render fast:** Render All ab 2 clips parallel karta hai + Stop button.
- **Professional captions:** naye styles — **Viral Bold** (bara bold ALL-CAPS, Reels look) aur **Premium Gold**. Fonts Inter / Plus Jakarta Sans / Noto Naskh / Nastaliq hain. Aakhri line mein aik akela lafz (orphan word) nahi chhorta.
- **Top heading professional:** 2-line wrapped headline, dark banner + neeli accent bar. Style chuno: Pro Banner / Minimal / Off.
- **Easy UI:** 1-tap presets, 4-step progress (Upload → Find → Review → Export), API status, Hook score badge, Clip List export.
- **Setup:** `setup.bat` (Node + FFmpeg check + install) aur `run.bat` — aik click mein chalao.

## Test karne se pehle — saaf baat

- Yahan sandbox mein `tsc` aur `vite build` pass hue hain aur server start hoke `/api/health` par key dikhata hai — lekin **live Gemini call aur Windows par lamba video render yahan test nahi ho saka**. Client ko dene se pehle apne computer par ye 3 cheezein check kar lo:
  1. Chhoti video (1-2 min) — Viral Reel preset, clips banein aur MP4 download ho.
  2. Urdu video — Urdu captions aur heading theek aayein.
  3. Lambi video (10+ min) — clips + Render All poora ho.
- Agar koi step fail ho to us waqt ka screenshot / error bhej dena — dobara extract mat karna.
