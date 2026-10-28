# Pixelgah Launcher

A launcher-style demo for a multi-category game store (Persian, RTL). Single self-contained `index.html`.

All products, prices, reviews and codes are sample content.

## Card games (میز ورق)

`hokm/` holds a separate project: a Persian (RTL) card-game hall played against bots. Single self-contained `hokm/index.html`, served at `/hokm/` on GitHub Pages. Games:

- Hokm (حکم): 4 players in teams, or 2 and 3 players head to head
- Shelem (شلم): Hokm with bidding from 100 to 165 and point cards
- Pasur (پاسور): 2 or 4 players, captures that sum to eleven, sur bonus
- Hearts (دل): passing, broken hearts, shooting the moon
- Haft Khabis (هفت‌خبیث): 2–4 players, sevens stack, jacks change the suit
- Rummy (رامی): 2–4 players, sets, runs and laying off
- Solitaire (پاسیانس): Klondike with draw 1 or 3, undo, hints and auto-finish

Play: https://arsalanxf-cmd.github.io/pixelgah-launcher/hokm/

## Online server (card-server)

`card-server/` is the online server for the card hall (Node.js + WebSocket). It serves the game page and runs every online table: rooms with invite codes, quick match, bots in empty seats, reconnecting mid-hand, move timers, leaderboards and a daily solitaire deal. Cards are dealt on the server, so each player only receives their own hand. Deploy guide (Persian) in `card-server/README.md`; with Docker it is `docker compose up -d --build` inside that folder.
