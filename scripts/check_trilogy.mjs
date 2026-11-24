#!/usr/bin/env node
// Fixture gate for the TS composite math (src/render/trilogy.ts) — the
// frontend has no test runner, so this compiles the pure modules with tsc
// into a temp dir and checks them against fixtures/rgb_expected.json
// (scripts/gen_rgb_fixtures.py, an independent numpy transcription). tsc
// follows type-only imports into api.ts, so output mirrors src/ (render/…).
//
//   npm run test:ts

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "voyager-ts-"));
try {
  execFileSync(
    join(root, "node_modules/.bin/tsc"),
    ["src/render/trilogy.ts", "src/render/wcs.ts", "src/render/warp.ts", "--outDir", out, "--module", "es2020",
     "--target", "es2020", "--moduleResolution", "node", "--strict", "--skipLibCheck"],
    { cwd: root, stdio: "inherit" },
  );
  writeFileSync(join(out, "package.json"), '{"type":"module"}');
  // Vite resolves extensionless relative imports; Node's ESM loader doesn't.
  for (const f of readdirSync(join(out, "render"))) {
    if (!f.endsWith(".js")) continue;
    const p = join(out, "render", f);
    writeFileSync(p, readFileSync(p, "utf8").replace(/(from\s+"\.\/[\w.-]+)(")/g, (m, a, b) => (a.endsWith(".js") ? m : `${a}.js${b}`)));
  }
  const T = await import(pathToFileURL(join(out, "render", "trilogy.js")).href);
  const { Wcs } = await import(pathToFileURL(join(out, "render", "wcs.js")).href);
  const W = await import(pathToFileURL(join(out, "render", "warp.js")).href);
  const exp = JSON.parse(readFileSync(join(root, "fixtures/rgb_expected.json"), "utf8"));

  let fails = 0;
  let checks = 0;
  const close = (got, want, tol, what) => {
    checks++;
    if (!(Math.abs(got - want) <= tol)) {
      fails++;
      console.error(`FAIL ${what}: got ${got}, want ${want}`);
    }
  };

  // Trilogy levels (x0, x1, x2 exact formulae; k from a different bisection).
  for (const set of exp.levels) {
    exp.bands.slice(0, 3).forEach((b, i) => {
      const got = T.trilogyLevels(b.stats, set.params);
      const want = set.per_band[i];
      for (const key of ["x0", "x1", "x2"]) close(got[key], want[key], 1e-12, `${b.filter} ${key}`);
      close(got.k, want.k, 1e-6 * want.k, `${b.filter} k`);
    });
  }

  // Composite pixels (the shader's CPU reference).
  for (const d of exp.draws) {
    for (const p of d.pixels) {
      const vals = p.values.map((v) => (v === null ? NaN : v));
      const got = T.compositePixel(vals, d.bands, d.stretch, d.saturation, d.bias, d.contrast);
      checks++;
      if ((got === null) !== (p.rgb === null)) {
        fails++;
        console.error(`FAIL ${d.name} (${p.x},${p.y}): background mismatch`);
        continue;
      }
      if (got) got.forEach((c, i) => close(c, p.rgb[i], 1e-9, `${d.name} (${p.x},${p.y})[${"RGB"[i]}]`));
    }
  }

  // Rainbow weights.
  for (const [n, want] of Object.entries(exp.rainbow)) {
    T.rainbowWeights(Number(n)).forEach((w, i) =>
      w.forEach((c, j) => close(c, want[i][j], 1e-12, `rainbow(${n})[${i}][${j}]`)),
    );
  }

  // Co-gridded check: the 3 bands match; the half-pixel-offset band does not.
  const grid = (b) => ({ nx: exp.nx, ny: exp.ny, wcs: new Wcs(b.wcs) });
  const ref = grid(exp.bands[0]);
  for (const b of exp.bands) {
    checks++;
    const why = T.gridMismatch(ref, grid(b));
    if ((why === null) !== b.same_grid) {
      fails++;
      console.error(`FAIL grid ${b.filter}: got ${why ?? "match"}, want ${b.same_grid ? "match" : "mismatch"}`);
    }
  }
  checks++;
  if (T.gridMismatch(ref, { nx: exp.nx + 1, ny: exp.ny, wcs: ref.wcs }) === null) {
    fails++;
    console.error("FAIL grid: size mismatch not caught");
  }

  // Reprojection (warp.ts): reference ↔ band pixels through both TAN WCSs
  // must match astropy, and the tile mesh's linear interpolation must stay
  // within 0.01 reference px of the exact map, even at coarse pyramid levels.
  for (const c of exp.warps) {
    const ref = { nx: exp.nx, ny: exp.ny, wcs: new Wcs(c.ref_wcs) };
    const band = { nx: 1, ny: 1, wcs: new Wcs(c.band_wcs) };
    const map = W.gridMapFor(ref, band);
    checks++;
    if (typeof map === "string" || map.identity) {
      fails++;
      console.error(`FAIL warp ${c.name}: expected a WCS warp, got ${typeof map === "string" ? map : "identity"}`);
      continue;
    }
    close(map.bandPerRef, c.band_per_ref, 1e-12, `warp ${c.name} bandPerRef`);
    for (const p of c.pairs) {
      const b = map.refToBand(p.ref[0], p.ref[1]);
      close(b[0], p.band[0], 1e-6, `warp ${c.name} refToBand(${p.ref}) x`);
      close(b[1], p.band[1], 1e-6, `warp ${c.name} refToBand(${p.ref}) y`);
      const r = map.bandToRef(p.band[0], p.band[1]);
      close(r[0], p.ref[0], 1e-6, `warp ${c.name} bandToRef x`);
      close(r[1], p.ref[1], 1e-6, `warp ${c.name} bandToRef y`);
    }
    // Mesh linearity: level 0 (256 px) and level 6 (16384 band px) tiles.
    // Cell centers lie on the shared diagonal of the cell's two triangles, so
    // the GPU puts them at the midpoint of that diagonal's two vertices.
    const n = W.MESH_CELLS;
    for (const size of [256, 256 * 64]) {
      const mesh = W.tileMesh(map, 0, 0, size, size);
      let worst = 0;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const b = (j * (n + 1) + i + 1) * 4;
          const cc = ((j + 1) * (n + 1) + i) * 4;
          const mx = (mesh[b] + mesh[cc]) / 2;
          const my = (mesh[b + 1] + mesh[cc + 1]) / 2;
          const e = map.bandToRef(((i + 0.5) / n) * size - 0.5, ((j + 0.5) / n) * size - 0.5);
          worst = Math.max(worst, Math.hypot(mx - (e[0] + 0.5), my - (e[1] + 0.5)));
        }
      }
      // Float32 vertex storage alone contributes ~1e-3 px at these coords.
      close(worst, 0, 0.01, `warp ${c.name} mesh error @${size}px tile`);
      if (size === 256) console.log(`  warp ${c.name}: mesh error ${worst.toExponential(2)} px (256-px tile)`);
    }
  }
  // The MIRI fixture band reprojects; a SIP-flagged one refuses.
  {
    const ref = { nx: exp.nx, ny: exp.ny, wcs: new Wcs(exp.bands[0].wcs) };
    const miri = exp.bands.find((b) => b.filter === "F770W");
    checks++;
    const m = W.gridMapFor(ref, { nx: miri.nx, ny: miri.ny, wcs: new Wcs(miri.wcs) });
    if (typeof m === "string" || m.identity) {
      fails++;
      console.error("FAIL warp: MIRI fixture should get a WCS warp");
    }
    checks++;
    const sip = W.gridMapFor(ref, { nx: 9, ny: 9, wcs: new Wcs({ ...miri.wcs, sip_ignored: true }) });
    if (typeof sip !== "string") {
      fails++;
      console.error("FAIL warp: a SIP-ignored WCS must not reproject");
    }
    checks++;
    if (W.gridMapFor(ref, ref) !== W.IDENTITY_MAP) {
      fails++;
      console.error("FAIL warp: same grid should map by identity");
    }
  }

  console.log(`check_trilogy: ${checks - fails}/${checks} passed`);
  process.exitCode = fails > 0 ? 1 : 0;
} finally {
  rmSync(out, { recursive: true, force: true });
}
