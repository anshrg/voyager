#!/usr/bin/env node
// Fixture gate for the TS composite math (src/render/trilogy.ts) — the
// frontend has no test runner, so this compiles the pure modules with tsc
// into a temp dir and checks them against fixtures/rgb_expected.json
// (scripts/gen_rgb_fixtures.py, an independent numpy transcription). tsc
// follows type-only imports into api.ts, so output mirrors src/ (render/…).
//
//   npm run test:ts

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "voyager-ts-"));
try {
  execFileSync(
    join(root, "node_modules/.bin/tsc"),
    ["src/render/trilogy.ts", "src/render/wcs.ts", "--outDir", out, "--module", "es2020",
     "--target", "es2020", "--moduleResolution", "node", "--strict", "--skipLibCheck"],
    { cwd: root, stdio: "inherit" },
  );
  writeFileSync(join(out, "package.json"), '{"type":"module"}');
  const T = await import(pathToFileURL(join(out, "render", "trilogy.js")).href);
  const { Wcs } = await import(pathToFileURL(join(out, "render", "wcs.js")).href);
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

  console.log(`check_trilogy: ${checks - fails}/${checks} passed`);
  process.exitCode = fails > 0 ? 1 : 0;
} finally {
  rmSync(out, { recursive: true, force: true });
}
