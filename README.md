# m59-strategy-game

A local strategy-game command surface for a fleet already owned and operated by
[`m59-harness`](../m59-harness/README.md).

The app does not log characters in, hold credentials, or create another broker.
It talks to the existing harness broker over its HTTP MCP endpoint, reads the
`fleet` snapshot, and translates a deliberately small set of game-themed orders
into broker tool calls.

World and zone maps are generated from `m59-harness/substrate/m59-map.json` and
the compendium zone model. The illustrated world view keeps the real
compass-exit topology available as an optional overlay;
each local view uses the same `.roo` wall geometry as the Meridian client and
compendium. Character markers come from cached broker perception and are not
invented map coordinates.

## Boundary

```text
browser -> local strategy app -> existing broker -> Meridian 59 sessions
```

This application is the fleet control plane, not a public dashboard. Development
and production preview servers bind explicitly to `127.0.0.1`, and the worker
rejects non-loopback hosts so an accidental hosted deployment does not expose it.
Write routes also reject cross-site browser requests. Keep all future fleet
controls inside this boundary.

The initial command set is:

- **March** -> `travel` with background movement
- **Farm** -> `autopilot` in named-target farm mode
- **Survive** -> `autopilot` in survive mode
- **Hold** -> `autopilot` in idle mode
- **Equip** -> `equip_best`
- **Stop** -> stop the character's autopilot
- **Local-map right click** -> stop the current keeper and `walk_to` that square
- **Exit right click** -> stop the current keeper and begin one-hop `travel`; the
  map follows the first selected unit to report from the destination zone
- **Form Group** -> save a named local group with a leader and editable formation
- **Formation keeper** -> stop individual autopilots, follow the leader between
  zones, and use short `walk_to` corrections to hold each rotated slot offset
- **Set Strategy** -> toggle independent DUM behaviors for selected units, including
  multi-item vault accumulation with compendium-derived monster drop highlights

The `/fleet` view has three tabs. **Command** is the map and roster surface, **DUM
bot** counts current-process rule interventions and verification outcomes, and
**Harness** totals keeper time by activity category for the current broker session.

Meridian has no server-side party or formation object. Groups are therefore a
localhost command-post convention: their definitions persist in browser storage,
and an engaged group is maintained while this control plane is open.

The harness's `leave` tool is intentionally not exposed. The order endpoint also
refuses non-loopback requests, so deploying the page does not deploy a public
fleet control plane.

## Run

Start the existing broker through `m59-harness`, then from this directory:

```powershell
npm install
npm run dev
```

Open <http://localhost:3000>. The default broker is
`http://127.0.0.1:8901`; override it with `M59_BROKER_URL` when necessary.
`predev` and `prebuild` refresh the generated map assets from the sibling harness.
