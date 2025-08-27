# FifthQtr Healthmate — Full Page Assistant

## Overview
This is a full-page chat assistant for players, officials and families.  
- Clean full-page layout (no floating widget)  
- Powered by Vercel serverless function + OpenAI (gpt-4.1)  
- Includes red-flag triage for urgent cases

## Deploy on Vercel
1. Create a new Vercel project from this repo.
2. In Settings → Environment Variables, add:
   - `OPENAI_API_KEY` = your key
3. Deploy.
4. Test:
   - `https://<your-app>.vercel.app/` → opens Healthmate chat
   - `https://<your-app>.vercel.app/api/mascot` → should return `{ "error": "Use POST" }`

## Add to WordPress
- Simply create a new WP page called **Healthmate**.  
- Add a button or menu item linking to:
