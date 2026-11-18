# Observation spec, version 2

Status: version 1 built 2026-11-16 and reviewed 2026-11-18; version 2 carries out that review (see the end).
Code: `js/core/observe.js`. Frozen layout: `schema/obs_v2.json` (`schema/obs_v1.json` is kept as the record of
version 1).
Tests: `js/test/observe.test.js` (what it may contain), `tests/test_observation.py` (transport).

## The rule and how it is enforced

REQUIREMENTS §3.3: the model never receives state a human player could not see on screen at that moment.

1. **Allowlist.** `observe.js` writes each value with an explicit extractor. Nothing is copied from game state and
   filtered afterwards. Each field below names the place in the game's renderer where the value is drawn.
2. **The screen is the reference, mechanically.** The tests run the game's own drawing code
   (`Renderer.drawRoom`, `HUD.draw`) against a recording canvas and require the observation to say the same:
   every sprite drawn is observed with the same type and position, and nothing is observed that was not drawn.
   Entity types *are* sprite names, so a disguised enemy can only ever be observed as its disguise.
3. **Non-interference.** The tests change hidden state (RNG, seed, hit points, timers, other rooms, the item
   list, internal velocities) and require the observation bytes to stay identical.
4. **Review gate.** Everything in the room needs a reviewed view. If something has none, the scenario is refused
   at reset, or the episode ends as truncated with reason `unreviewed`. The thing is neither shown nor silently
   hidden from a model that keeps playing.
5. **Tied to the game version.** On first use the observer checks the loaded game against what was reviewed
   (sprite names, behaviours without drawing hooks of their own, vocabularies). A mismatch is a fault.
6. **Versioned (R9).** Any change to fields or vocabularies fails a test until the version is raised and the
   snapshot rewritten. `describe()["obs"]` carries id, version and a layout hash for checkpoints.

## Fields

Units: positions in room pixels (960 × 576, origin top left), velocities in pixels per second, health in half
hearts. Type indices start at 1; 0 means none. Nothing is normalised; that is the trainer's choice.

| Field | Shape | Content |
|---|---|---|
| `player` | 29 | position, velocity, pose, and the HUD bar values |
| `hud` | 11 | floor number, clock, boss bar, list totals |
| `enemies`, `enemy_mask` | 32 × 15, 32 | visible enemies, nearest first |
| `shots`, `shot_mask` | 96 × 8, 96 | projectiles of both sides and bombs, nearest first |
| `pickups`, `pickup_mask` | 16 × 9, 16 | things on the floor, nearest first |
| `tiles` | 9 × 15 | tile class as drawn |
| `tile_prop`, `tile_damaged` | 9 × 15 each | kind of destructible prop on a tile, and whether it shows damage |
| `doors` | 4 × 5 | per side (up, right, down, left): present, kind, locked, closed, crack |
| `minimap` | 5 × 7 × 8 | the minimap window around the current room |
| `items`, `item_mask` | 64, 64 | passive items held, in pickup order |

6,708 bytes per environment. Lists are sorted by distance to the player's sprite, then by position. Above a cap
the nearest are kept and `hud.*_total` reports how many are on screen.

### `player`

| Column | Where it is on screen |
|---|---|
| `x`, `y` | the player sprite (`player.js draw`) |
| `vx`, `vy`, `fresh` | displacement of the sprite over the last frame × 60. `fresh` = 1 when there is no previous frame to compare with (after reset, after entering a room); velocity is then 0 |
| `facing` | which of the four player sprites is drawn (0 up, 1 down, 2 left, 3 right) |
| `invulnerable` | the sprite blinks. How long it will keep blinking is not observed |
| `floating` | the sprite hovers above its shadow (To the Moon) |
| `hearts_visible`, `health`, `max_health`, `guardrails` | the heart row (`hud.js drawHearts`) |
| `credits`, `pushes`, `approvals` | the three counters (`drawCounter`) |
| `stats_visible`, `damage`, `fire_rate`, `speed`, `range`, `shot_speed`, `luck` | the stat block (`drawStats`), rounded exactly as printed: two decimals, range and luck as integers. `fire_rate` is the printed rate, not the internal delay |
| `active_visible`, `active_item`, `active_charge`, `active_max` | the active item box and its charge bar (`drawActive`) |
| `lock_active`, `lock_pushes`, `lock_fire` | the "LOCKED" / "ENCRYPTED" stamps (`drawEncrypted`) |

### `hud`

| Column | Where it is on screen |
|---|---|
| `depth` | "FLOOR n" (`drawFloorLabel`) |
| `clock` | the mm:ss clock, in whole seconds |
| `minimap_visible` | 0 while the map is under glitch static |
| `boss_bar`, `boss_ratio`, `boss_type`, `boss_side_quest` | the boss bar (`drawBossBar`): fill ratio over the whole boss group, the printed name, the "SIDE QUEST:" prefix |
| `enemies_total`, `shots_total`, `pickups_total` | how many are drawn (the lists hold at most their cap) |
| `items_total` | how many passive items are held (the list holds at most 64) |

### `enemies`

| Column | Where it is on screen |
|---|---|
| `type` | the sprite drawn (`AI.drawBody`), index into `vocab.sprites` |
| `x`, `y`, `vx`, `vy`, `fresh` | sprite position and its displacement over the last frame |
| `r` | radius of the shadow under it (`renderer.js drawShadow`) |
| `scale` | sprite scale (a Memory Leak grows) |
| `alpha` | sprite opacity, including the fade-in while an enemy wakes up after spawning |
| `flip` | the sprite is mirrored (it moves left) |
| `flash` | hit flash |
| `frozen` | frost shimmer |
| `flying` | the shadow is drawn lower |
| `hp_shown`, `hp_ratio` | the health bar, only while the Code Review item draws it (`drawHpBar`) |

An enemy with neither a visible sprite nor a shadow is not listed.

### `shots`

| Column | Where it is on screen |
|---|---|
| `type` | `shot_player` or `shot_enemy` (the plain circle in the side's colour), `bomb`, or a shot's own sprite |
| `x`, `y`, `vx`, `vy`, `fresh` | position and displacement over the last frame |
| `r` | radius of the circle |
| `urgent` | a bomb in its last 0.6 s blinks faster. The exact fuse is not observed |

### `pickups`

| Column | Where it is on screen |
|---|---|
| `type` | the sprite: a pickup type, `pickup_chest_open`, `trapdoor`, `pipe` |
| `x`, `y`, `vx`, `vy`, `fresh` | position and displacement (drops slide a little) |
| `r` | size |
| `alpha` | a pipe is drawn half transparent until it is active |
| `price` | the price tag of a shop item, 0 otherwise |

### Room

- `tiles`: 0 floor, 1 wall, 2 rock, 3 block, 4 pit, 5 spikes, 6 door, 7 prop, 8 cactus. A hidden door reads as
  wall.
- `tile_prop`: index into `vocab.prop_kinds` (sprite `prop_<kind>`); `tile_damaged`: the damaged frame is shown.
- `doors`: `kind` indexes `vocab.door_kinds` (frame style, signs); `locked` = padlock and chain; `closed` = the
  door leaves are shut (combat, or locked); `crack` = the crack the game draws on the wall over a hidden door
  (`renderer.js bakeBackground`, always drawn, for every hidden door). `crack` is only ever set where `present`
  is 0.

### `items`

Indices into `vocab.passive_items`, in the order the items were picked up, repeats included; the first 64 are
kept and `hud.items_total` counts all of them. The active item is not in this list; it is in the HUD box
(`player.active_item`).

This is the one field that is not on the screen of the current frame. It is a record of what was on screen
earlier: every passive item reaches the player through `Player.giveItem`, which puts the item's name in a
banner, and the game has no way of removing an item again. The pause screen shows the same list. Whether the
model receives it is the trainer's choice; a strictly "this frame only" model drops the field.

### `minimap`

The 7 × 5 window of `hud.js drawMinimap`, current room in the middle (row 2, column 3). Per cell:

| Channel | Meaning |
|---|---|
| `state` | 0 not shown, 1 seen (outline), 2 visited, 3 current |
| `icon` | room icon: boss, treasure, shop, secret, terms |
| `link_up`, `link_right`, `link_down`, `link_left` | a connection bar is drawn in the gap on that side |
| `scan` | coloured outline from Deep Packet Inspection (boss or secret) |
| `scan_edge` | a dot on the window edge pointing at a scanned room outside the window |

The conditions are the HUD's own: a room appears once seen; connections are drawn from visited rooms (from all
seen rooms after README.md); secret rooms stay out until their door is open.

## Reviewed content

Only these may appear. Everything else in the game is behind the gate.

| Thing | What it shows | What stays hidden |
|---|---|---|
| **Bug** (`bug`, behaviour `wander`) | Body only: walks in straight lines, turns at random or when it bumps into something. No telegraph exists. | When it will turn next and where to (`state.wanderT`, RNG). Hit points. |
| **Null Pointer** (`null_pointer`, `fly_chase`) | Body only, flying: heads for the player with a wobble. | The wobble phase. Hit points. |
| **Memory Leak** (`memory_leak`, `split`) | Body only; grows slowly (visible as `scale` and `r`); splits into Leaklets when killed. | Hit points. How many Leaklets come out (two, three if fully grown; the size that decides it is visible). |
| **Leaklet** (`leaklet`, `chase`) | Body only: walks toward the player around obstacles. Fades in for 0.3 s after the split. | Its path plan. Hit points. |
| Projectiles (`Projectile`) | A circle in the side's colour with its radius, or its own sprite. | Damage, remaining range, flags such as homing or piercing (their effect shows only as motion). |
| Bomb (`Bomb`) | Sprite, blinking; faster in the last 0.6 s. | Exact fuse, damage, blast radius. |
| Pickups (`Pickup`), all 11 types | Sprite, price tag, the opened chest. | The short delay before a fresh drop can be collected. What a chest holds. |
| Trapdoor, Pipe | Sprite; the pipe is half transparent while inactive. | Where a pipe leads. |
| Props (crate, bush, package, carton, sandcastle) | Sprite on the tile, damaged frame below half health. | Exact hit points. |

"Body only" means the enemy's behaviour has no drawing code of its own, so everything it shows is what
`AI.drawBody` and the shadow draw. The observer verifies this against the loaded game.

Not reviewed, therefore refused for now: 46 further enemy ids (among them Hallucination and Trojan), all 14 bosses,
pedestals and Terms of Service, familiars, shots with sprites of their own. A full run on floor 1 therefore
ends as `unreviewed` at the first such room; the floor-1 roster and bosses are Phase 4.

## The special cases of §3.3

| Case | Version 1 | Test |
|---|---|---|
| Hallucination | Refused by the gate. Its later view must report the disguise pickup; the sprite cross-check will enforce that. | "review gate" tests |
| Trojan | Refused by the gate. Its later view must also paint the tile grid as a prop. | "review gate" tests |
| Secret rooms | The crack on the wall is observed (`doors.crack`), since the game draws it for every hidden door. Otherwise a hidden door is absent from `doors`, its tile reads as wall, and the room and its connection are not on the map: a plain wall differs only in the crack flag. After a Force Push opens it, door, map cell and icon appear and the crack is gone. The crack is cross-checked against the background bake. | "secret rooms" |
| Floor map | Compared with the HUD's drawing in every room of five floors, with README.md and the scanner. | "the minimap is what the HUD draws", "floor map" |
| Enemy health | Zero unless the health bar is drawn; then the drawn ratio. | "enemy health" |
| Boss bar | Always, as the HUD draws it. | "boss bar" |
| Graphics Glitch | The scrambled area (hearts, stats, active item or minimap) is zeroed with its `*_visible` flag at 0 on exactly the frames the HUD scrambles it. In the last second the HUD flickers on its own clock; the values are observed in the gaps, as a human reads them. Cross-checked frame by frame against the HUD's drawing. Without the game clock (`write(B)` with no clock) the area stays masked for the whole glitch. | "Graphics Glitch" |
| Enemy internals | Not read. | "hidden state does not reach the observation" |
| Pedestals, Terms of Service | Refused by the gate. | "review gate" tests |
| RNG state, seed, other rooms | Not read. | "hidden state does not reach the observation" |
| Inventory | The passive items held are observed as a list (`items`), justified by the pickup banner that names each one. Optional for the trainer. | "passive items" |

## Visible to a human but not observed

Safe under the rule, but the model has less than a human in these points:

- Banners (item name and description after a pickup, "secret room found") and the item held overhead.
- Enemy speech text, particle effects, explosion flashes, scenery (fireflies, rain, tumbleweed), screen shake.
- Projectile colour beyond the side it belongs to.
- Sprite animation frames, including which exact frames the player sprite is hidden while blinking.
- The Swap File bar under the hearts.

## Review of version 1 (2026-11-18)

| Question | Decision | Version 2 |
|---|---|---|
| Secret-door crack | Observe it. A perfect human player spots it every time. | `doors.crack` |
| Passive items | Expose them as a list; the trainer may leave it out, and probably will at first (most items are a net gain anyway). | `items`, `item_mask`, `hud.items_total` |
| List caps | Kept: 32 enemies, 96 shots, 16 pickups per observation, nearest kept, totals reported. | unchanged |
| Glitch flicker | Follow the screen exactly. | masks follow `hud.js glitchFor` frame by frame |

## Adding a view

1. Read the entity's update and draw code in the pinned game; write down what it draws and what it keeps hidden.
2. Add it to the reviewed table in `observe.js` (and to the vocabulary if it draws a new sprite); extend the
   extractor only with values that are drawn.
3. Add a row to "Reviewed content" above, and extend the screen cross-check so the entity occurs in it.
4. Raise the version, rewrite the snapshot (`node js/node/schema.js --write`), run both suites.
