import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the starter surface has been replaced by field command", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(page, /Strategic field map/);
  assert.match(page, /Unit roster/);
  assert.match(page, /world-map-svg/);
  assert.match(page, /addEventListener\("wheel", zoomWorldMap, \{ passive: false \}\)/);
  assert.match(page, /onPointerMove=\{updateWorldPan\}/);
  assert.match(page, /WORLD_MAX_ZOOM/);
  assert.match(page, /setWorldScope\("all"\)/);
  assert.match(page, /Show game connections/);
  assert.match(page, /\/maps\/stratmap\.png/);
  assert.match(page, /CARTOGRAPHIC_ANCHORS/);
  assert.match(page, /room-unit-dot/);
  assert.match(page, /room-monster-dot/);
  assert.match(page, /Overlay safe spot ledger/);
  assert.match(page, /safe-spot-ledger/);
  assert.match(page, /map-legend-toggle/);
  assert.match(page, /aria-pressed=\{showCompanyLayer\}/);
  assert.match(page, /onDoubleClick=\{\(\) => openUnitMap\(unit\)\}/);
  assert.match(page, /onDoubleClick=\{beginCompanyNameEdit\}/);
  assert.match(page, /m59-field-command-company-name/);
  assert.match(page, /openUnitDetails/);
  assert.match(page, /unit-detail-button/);
  assert.match(page, /hero-detail-frame/);
  assert.match(layout, /M59 Field Command/);
  assert.match(packageJson, /"name": "m59-strategy-game"/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("zone maps can overlay the broker's safe-spot ledger", async () => {
  const [page, route, css] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/api/safe-spots/route.ts", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(page, /showSafeSpots/);
  assert.match(page, /const KOD_FINENESS = 64/);
  assert.match(page, /roomMap\.transform\.fineness \/ KOD_FINENESS/);
  assert.match(page, /spot\.exactX \* kodToRoomScale/);
  assert.match(page, /safe-spot-marker/);
  assert.match(page, /safeSpotCounts/);
  assert.match(page, /visibleSafeSpotMarkers/);
  assert.match(page, /spot\.verdict === "verified" \? "holds"/);
  assert.match(page, /safeSpotLayers\[layer\]/);
  assert.match(css, /map-legend-toggle\.disabled[^}]*text-decoration: line-through/);
  assert.match(route, /callBrokerTool\("safe_spots"/);
  assert.match(route, /envelope\.known/);
  assert.match(route, /failed > 0 \? "failed"/);
  assert.doesNotMatch(route, /writeFile|callBrokerTool\("walk_to"|callBrokerTool\("leave"/);

  // A KOD fine coordinate at the centre of column 45 must land at the same
  // client/.roo coordinate as the row/column fallback.
  const exactKodX = 45 * 64 + 32;
  assert.equal(exactKodX * (1024 / 64), (45 + 0.5) * 1024);
});

test("local unit coordinates are read from broker perception without a game round trip", async () => {
  const route = await readFile(new URL("app/api/room-state/route.ts", root), "utf8");

  assert.match(route, /callBrokerTool\("look", \{ agent, cached: true \}\)/);
  assert.match(route, /look\.you\?\.col/);
  assert.match(route, /look\.you\?\.row/);
  assert.match(route, /object\.can\.includes\("attack"\)/);
  assert.match(route, /monstersById/);
  assert.doesNotMatch(route, /walk_to|travel|move/);
});

test("the field map is generated from harness world and room geometry", async () => {
  const [sync, world, corNoth] = await Promise.all([
    readFile(new URL("scripts/sync-maps.mjs", root), "utf8"),
    readFile(new URL("public/maps/world.json", root), "utf8").then(JSON.parse),
    readFile(new URL("public/maps/rooms/150.json", root), "utf8").then(JSON.parse),
  ]);

  assert.match(sync, /m59-harness/);
  assert.ok(world.nodes.length >= 100);
  assert.equal(corNoth.name, "Cor Noth");
  assert.equal(corNoth.file, "cornoth.roo");
  assert.equal(corNoth.rows, 46);
  assert.equal(corNoth.cols, 70);
  assert.ok(corNoth.solidPath.length > 1000);
  assert.ok(corNoth.exits.some((exit) => exit.toRoom && exit.kind === "door"));
  assert.ok(corNoth.exits.some((exit) => exit.toRoom && exit.kind === "edge"));
});

test("local maps provide RTS selection, direct movement, and first-scout exit following", async () => {
  const [page, route] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/api/map-orders/route.ts", root), "utf8"),
  ]);

  assert.match(page, /beginMapSelection/);
  assert.match(page, /room-selection-box/);
  assert.match(page, /selectUnitStack/);
  assert.match(page, /onContextMenu=\{commandMapSquare\}/);
  assert.match(page, /Following the first unit through/);
  assert.match(route, /callBrokerTool\(\s*"walk_to"/);
  assert.match(route, /"go_through"/);
  assert.match(route, /report\.left === true/);
  assert.match(route, /exitCol/);
  assert.match(route, /callBrokerTool\("cancel_movement"/);
  assert.doesNotMatch(route, /background: true/);
  assert.match(route, /isLocalCommandRequest\(request, true\)/);
  assert.doesNotMatch(route, /callBrokerTool\("leave"/);
});

test("the group manager provides persistent formations and an offset-follow keeper", async () => {
  const [page, formations, formationRoute] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("lib/formations.ts", root), "utf8"),
    readFile(new URL("app/api/formations/route.ts", root), "utf8"),
  ]);

  assert.match(page, /Formation editor/);
  assert.match(page, /Form group/i);
  assert.match(page, /m59-field-command-groups-v1/);
  assert.match(page, /Engage formation/);
  assert.match(page, /formation-ghosts/);
  for (const preset of ["conga", "t", "circle", "scattered"]) {
    assert.match(formations, new RegExp(`"${preset}"`));
  }
  assert.match(formations, /formationTarget/);
  assert.match(formationRoute, /action: "tick"/);
  assert.match(formationRoute, /callBrokerTool\("travel"/);
  assert.match(formationRoute, /"walk_to"/);
  assert.match(formationRoute, /isLocalCommandRequest\(request, true\)/);
  assert.doesNotMatch(formationRoute, /callBrokerTool\("leave"/);
});

test("releasing a formation invalidates stale ticks and hard-stops old movement", async () => {
  const [page, route, control, broker] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/api/formations/route.ts", root), "utf8"),
    readFile(new URL("lib/formation-control.ts", root), "utf8"),
    readFile(new URL("../m59-harness/tools/m59-broker.mjs", root), "utf8"),
  ]);

  assert.match(page, /Break selected/);
  assert.match(page, /formationTickAbort\.current\?\.abort\(\)/);
  assert.match(page, /sendFormationRelease/);
  assert.match(page, /window\.addEventListener\("storage", synchronizeGroups\)/);
  assert.match(page, /A formation is a live command lease, not a preference/);
  assert.match(route, /formationIsEngaged/);
  assert.match(route, /callBrokerTool\("cancel_movement"/);
  assert.match(route, /control_token/);
  assert.match(control, /active: false/);
  assert.match(control, /current\?\.revision/);
  assert.match(broker, /name: 'cancel_movement'/);
  assert.match(broker, /cancelledMovementTokens/);
  assert.match(broker, /movementGeneration\+\+/);
});

test("the order adapter exposes the bounded strategy command set", async () => {
  const [route, localAccess] = await Promise.all([
    readFile(new URL("app/api/orders/route.ts", root), "utf8"),
    readFile(new URL("lib/local-access.ts", root), "utf8"),
  ]);

  for (const action of ["march", "farm", "survive", "hold", "stop", "equip"]) {
    assert.match(route, new RegExp(`"${action}"`));
  }
  assert.match(route, /isLocalCommandRequest\(request, true\)/);
  assert.match(localAccess, /sec-fetch-site/);
  assert.match(localAccess, /originUrl\.origin === requestUrl\.origin/);
  assert.doesNotMatch(route, /callBrokerTool\("leave"/);
  assert.doesNotMatch(route, /account|password|credentials/);
});

test("selected units can opt into independent DUM strategies", async () => {
  const [page, route, css] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/api/strategies/route.ts", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);
  assert.match(page, /Set strategy/i);
  assert.match(page, /strategyGroups/);
  assert.match(page, /Mixed means only part/);
  assert.match(page, /requirements\.join/);
  assert.match(page, /strategySettingChanges/);
  assert.match(page, /type="number"/);
  assert.match(route, /settings/);
  assert.match(route, /M59_DUM_CONTROL_URL/);
  assert.match(route, /127\.0\.0\.1:8916/);
  assert.match(route, /isLocalCommandRequest\(request, true\)/);
  assert.match(css, /\.strategy-group/);
  assert.match(css, /\.strategy-option\.some/);
  assert.match(css, /\.strategy-settings/);
  assert.doesNotMatch(route, /callBrokerTool\("leave"|account|password|credentials/);
});

test("fleet tabs expose DUM interventions, keeper clocks, and drop-aware vault settings", async () => {
  const [page, observability, drops, fleetPage, broker, css] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/api/observability/route.ts", root), "utf8"),
    readFile(new URL("app/api/drop-sources/route.ts", root), "utf8"),
    readFile(new URL("app/fleet/page.tsx", root), "utf8"),
    readFile(new URL("lib/m59-broker.ts", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);
  assert.match(page, /DUM bot/);
  assert.match(page, /Keeper time by unit/);
  assert.match(page, /type="text" value=\{value\} list="known-drop-items"/);
  assert.match(page, /farmed-drop/);
  assert.match(observability, /\/observability/);
  assert.match(drops, /callBrokerTool\("drop_sources"/);
  assert.match(fleetPage, /default.*from "\.\.\/page"/);
  assert.match(broker, /fighting_s/);
  assert.match(css, /\.telemetry-workspace/);
  assert.match(css, /\.room-monster-marker\.farmed-drop/);
});

test("the entire fleet control plane is bound and gated to localhost", async () => {
  const [vite, worker] = await Promise.all([
    readFile(new URL("vite.config.ts", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
  ]);

  assert.match(vite, /host: "127\.0\.0\.1"/);
  assert.match(worker, /isLoopbackHostname/);
  assert.match(worker, /available only on localhost/);
});

test("fleet responses are explicitly reduced to safe strategy fields", async () => {
  const broker = await readFile(new URL("lib/m59-broker.ts", root), "utf8");

  assert.match(broker, /toSafeFleetUnit/);
  assert.doesNotMatch(broker, /^\s+(account|password|credentials):/m);
});

test("unit dossiers proxy only the read-only hero ledger", async () => {
  const route = await readFile(new URL("app/api/hero/route.ts", root), "utf8");

  assert.match(route, /callBrokerTool\("fleet", \{\}\)/);
  assert.match(route, /script-src 'none'/);
  assert.match(route, /sanitizeHeroPage/);
  assert.doesNotMatch(route, /credentials|start\.ps1|callBrokerTool\("leave"/);
});
