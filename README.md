# Toronto Neighbourhood Challenge 🗺️

A real-time multiplayer map game where teams compete to claim Toronto neighbourhoods.

## Setup

1. **Clone the repo**
2. **Copy the config template:**
   ```bash
   cp config.example.js config.js
   ```
3. **Fill in your Firebase credentials** in `config.js`
4. **Open `index.html`** in your browser

## Firebase Setup

This app uses Firebase Realtime Database. You'll need a Firebase project with:
- Realtime Database enabled
- Appropriate security rules for your use case

Get your config from **Firebase Console → Project Settings → Your apps → Config**.

## Files

| File | Description |
|------|-------------|
| `index.html` | Main app (HTML + CSS + JS) |
| `config.js` | Your Firebase credentials (**gitignored**) |
| `config.example.js` | Template — copy to `config.js` |
