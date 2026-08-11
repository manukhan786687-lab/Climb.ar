# Hammer Climb

An original 2D physics climbing game. You control a cartoon character whose lower
body is stuck in a large pot — the only way to move is by swinging a long hammer
against the world and hauling yourself upward. Built with vanilla HTML/CSS/JS and
[Matter.js](https://brm.io/matter-js/) for physics. No build step, no backend.

## Files

```
index.html   – markup: canvas, HUD, menus, pause/settings/victory screens
style.css    – mobile-friendly cartoon UI theme
game.js      – physics, player, hammer control, camera, level generation,
               collisions, audio, save/load, and the game loop
```

## Run it locally

You just need a local static file server (opening `index.html` directly with
`file://` can block some browsers from loading the Matter.js CDN script or
using certain APIs, so a tiny server is recommended):

**Option A — Python (already on most machines):**
```bash
cd hammerclimb
python3 -m http.server 8000
```
Then open `http://localhost:8000` in your browser (or on your phone, if it's
on the same Wi-Fi network, use your computer's local IP instead of
`localhost`).

**Option B — Node:**
```bash
npx serve hammerclimb
```

**Option C — VS Code:** install the "Live Server" extension and click
"Go Live" with `index.html` open.

The game needs an internet connection the first time it loads, since
Matter.js is pulled from a CDN (`cdn.jsdelivr.net`) — after that, only the
three local files matter.

## Controls

- **Touch (mobile):** drag your finger around your character to aim the
  hammer; keep your finger down to actively swing it. Lift your finger to
  let the hammer swing freely under gravity.
- **Mouse (desktop):** move the mouse to aim, hold the left button to
  actively drive the hammer.
- **Keyboard (alternative desktop control):** Arrow keys / WASD to rotate
  and extend the hammer's aim, Space to actively swing it.

## Publish on GitHub Pages

1. Create a new GitHub repository (e.g. `hammer-climb`).
2. Push these three files (`index.html`, `style.css`, `game.js`) to the
   repository's default branch:
   ```bash
   cd hammerclimb
   git init
   git add .
   git commit -m "Hammer Climb"
   git branch -M main
   git remote add origin https://github.com/<your-username>/hammer-climb.git
   git push -u origin main
   ```
3. On GitHub, go to **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Choose the **main** branch and the **/ (root)** folder, then **Save**.
6. After a minute or two, your game will be live at
   `https://<your-username>.github.io/hammer-climb/`.

That URL works on both desktop and mobile browsers — open it on your phone
to play with touch controls.

## Notes on design

- The character + pot is a single rigid ("compound") physics body — the pot
  has real collision geometry and the character reacts naturally to every
  hit and fall.
- The hammer is a separate physics body attached to the character's hand
  through a Matter.js constraint (a pin joint), so it swings, collides, and
  transmits force back into the player exactly like a real lever.
- The mountain is procedurally generated from a fixed seed (so it's the same
  climb every run, letting you practice) and moves through four visual
  zones: junkyard, rocky mountain, industrial clouds, and a sky tower at the
  peak.
- Best height and all settings are saved locally via `localStorage` — no
  account or server needed.
