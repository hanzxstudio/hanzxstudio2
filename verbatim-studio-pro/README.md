<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/edf98736-6ead-4570-9129-f6f7c09a92f5

## Run Locally

**Prerequisites:** Node.js + FFmpeg (see `SETUP-VERBATIM.md` for Roman Urdu steps)

**Windows — easiest:** double-click `setup.bat`, then `run.bat`, and open http://localhost:3000

**Manual:**

1. Install dependencies:
   `npm install`
2. `GEMINI_API_KEY` is already set in `.env.local` (server loads `.env.local` first, then `.env`). To change it later, use Auto Clips > Change Key inside the app — no restart needed. Never share `.env` / `.env.local` with a client.
3. Run the app:
   `npm run dev`
