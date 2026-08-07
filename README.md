# Jet Lag The Game - Toronto Stateside Scramble

A real-time multiplayer map game where three teams compete to claim Toronto
neighbourhoods. Any device can join as a team, claim territory, and manage
the shared game state — there's no game-master role.

## How it works

- **Teams.** Each device picks Team 1, Team 2, or Team 3. That choice is
  saved locally on the device (it isn't synced), which is what keeps a
  team's private cards visible only on that team's own device(s).
- **The Flop.** Any device can reveal the Flop, a shared draw of 9
  neighbourhoods (drawn from a 64-neighbourhood pool plus 3 wildcards).
  Once revealed, any team can tap a Flop tile to claim it. Cards can also
  be added to or removed from the Flop as the game goes on.
- **Private cards.** Each team also has its own hand of 5 private
  neighbourhoods, dealt at the start of the game and hidden from the other
  teams. A team can reveal its private cards one at a time and then claim
  any revealed-but-unclaimed card — this lets a team claim a neighbourhood
  that was never in the Flop.
- **Wildcards.** The Flop's 3 wildcard slots don't map to a specific
  neighbourhood on the map. Claiming one lets a team claim *any*
  neighbourhood on the map that isn't claimed yet — including one sitting
  in another team's private hand. If that happens, the card is removed
  from the original team's hand automatically; it no longer shows as
  claimable for them.
- **Claiming.** A neighbourhood can be claimed either by tapping it
  directly on the map or by tapping its tile in the Flop or private-card
  list. Once claimed, it's shaded with the claiming team's color
  everywhere in the app.
- **Clearing a claim.** Toggle "Clear a Claim," then tap a claimed
  neighbourhood to release it back to the pool.
- **Resetting the game.** Team 1 can reset the game from the Flop &
  Cards screen. This clears all claims and deals a fresh Flop and fresh
  private hands.

All game state (claims, the Flop, and private hands) syncs live across
devices through Firebase; each device also keeps a local copy so the game
still works offline or before Firebase connects.

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

If `config.js` isn't filled in (or Firebase fails to initialize), the app
falls back to a local-only save on that device, so you can still play and
test without setting up Firebase.

## Files

| File | Description |
|------|-------------|
| `index.html` | App markup and screen layout |
| `styles.css` | All styling |
| `app.js` | Game logic: roles, claims, the Flop, private cards, map rendering, Firebase sync |
| `config.js` | Your Firebase credentials (**gitignored**) |
| `config.example.js` | Template — copy to `config.js` |
| `toronto_140_neighbourhoods.geojson` | Neighbourhood boundary data (only the 64 neighbourhoods used by the game are rendered) |

## Credits

- **Neighbourhood boundaries** — [City of Toronto Open Data](https://open.toronto.ca/), Neighbourhoods dataset. Used and redistributed under the [Open Government Licence – Toronto](https://open.toronto.ca/open-data-license/).
- **Base map tiles** — © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- **Map rendering** — [Leaflet](https://leafletjs.com/).
- **Real-time sync** — [Firebase Realtime Database](https://firebase.google.com/products/realtime-database) (Google).
- **Fonts** — [Oswald](https://fonts.google.com/specimen/Oswald), [Inter](https://fonts.google.com/specimen/Inter), and [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono), all via Google Fonts, licensed under the [SIL Open Font License](https://scripts.sil.org/OFL).
