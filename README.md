# Thresholds

You start in a dark room with a single door. Open it and you step into a
procedurally generated world you can walk, run, jump and glide across. Scattered
through that world are more doors — each one leads somewhere else. Press **R**
at any time to wake up back in the dark room.

Everything is generated at runtime from integer seeds: no models, textures or
audio files. It is plain ES modules + [three.js](https://threejs.org) (vendored in
`vendor/`), so there is **no build step**.

## Run it

```bash
npm start            # serves http://localhost:8080  (PORT=3000 npm start to change it)
```

Any static file server works too (`python3 -m http.server`, `npx serve`, …) —
the page just has to be served over `http://`, not opened as a `file://`.
Use a desktop browser with WebGL2; click **Begin** to capture the mouse.

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` / mouse | walk / look |
| `Shift` | run |
| `Space` | jump — press again in the air to double jump — **hold while falling to glide** |
| `E` | open the door you are looking at, then walk through it |
| `R` | return to the dark room (from anywhere) |
| `M` | mute |
| `G` | cycle graphics quality (low / medium / high) |
| `Esc` | release the mouse (pause) |

Door colours hint at what lies behind them: green for rolling hills, amber for
the golden moor, blue-violet for moonlit downs, cyan for the floating isles,
coral for the dunes. The beams of light you can see from afar are doors.

## The worlds

| World | What it is |
| --- | --- |
| **Windswept Hills** | Long, wind-streamlined green ridges covered in grass that ripples with gusts, leaning trees, wildflowers and boulders. |
| **Amberwind Moor** | The same idea at golden hour: tall amber grass flattened by a strong wind, standing stones, a low sun. |
| **Moonlit Downs** | Night version with stars, a moon, teal grass, glowing flowers and fireflies. |
| **Floating Isles** | Grassy islands drifting over a sea of clouds. Gaps are bridged by stepping stones; the rest is jump, double jump and glide. Fall through the clouds and you respawn on the last island you stood on. |
| **Dune Sea** | Asymmetric sand dunes, cacti, sandstone outcrops and blowing sand. |

Every door picks its destination from the seed of the world it stands in, so
worlds are endless and the same seed always rebuilds the same place. The door
you arrive beside leads back to where you came from (with its exact position
restored); **R** always returns to the room.

## Deep links & debugging

```
?world=islands&seed=42      jump straight into a world (biomes: verdant golden moonlit islands dunes)
&autostart                  skip the title screen (no pointer lock; drag to look)
?quality=low                force a graphics preset and disable auto-adjust
?debug                      exposes window.game in the console
```

## How it works

* **Seeds everywhere.** `src/util/rng.js` + `noise.js` give hashed, deterministic
  randomness. Terrain, door sites, scenery and island layouts are pure functions
  of `(seed, coordinates)`, which is what lets the world be infinite and lets
  return doors rebuild a world exactly.
* **Terrain** (`worlds/terrainWorld.js`) streams 64 m chunks around the player.
  Each chunk builds a heightfield mesh, scatters props, and (nearby) a few
  thousand grass blades. The spawn point is slid to a calm patch of ground, and
  terrain is flattened around every door.
* **Grass & wind** (`gfx/materials.js`) — blades are instanced and bent entirely in
  the vertex shader by a travelling gust function that trees share, so waves of
  wind visibly sweep across a hillside.
* **Baked lighting** (`gfx/lighting.js`, `gfx/builder.js`) — sun and sky light are
  baked into vertex colours, so the world uses cheap unlit materials and
  everything (terrain, grass, props, doors) always agrees.
* **Floating islands** (`worlds/islandWorld.js`) sit on a jittered lattice. Each is
  a lumpy disc with a rocky inverted-cone underside, hanging roots and crystals.
  The player collides with the top surface, the cliff hull and the underside.
* **Doors** (`door.js`) have a swinging leaf, a portal surface tinted with the
  destination's sky, collision, and a light beam. `main.js` keeps a history
  stack so back-doors work.
* **Audio** (`audio.js`) — wind, room drone, footsteps and door sounds are
  synthesised with Web Audio.

```
index.html  style.css  serve.mjs  package.json
vendor/three.module.min.js
src/main.js            game loop, world switching, history, quality
src/player.js          movement, jump / double jump / glide, camera feel
src/door.js            door model, animation, portal, collision
src/colliders.js       circle / oriented-box colliders
src/worlds/            baseRoom, terrainWorld (+ terrainConfigs), islandWorld, biomeData
src/gfx/               materials & shaders, mesh builder, baked lighting, props
```

### Adding a new terrain world

1. Add an entry to `BIOME_DATA` (`worlds/biomeData.js`) — name, door colours, door styles.
2. Add a matching entry to `TERRAIN_CONFIGS` (`worlds/terrainConfigs.js`) — height
   function, palette, grass, props, sky, fog, wind, particles.

Nothing else needs to change: doors in other worlds start leading to it automatically.
