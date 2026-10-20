"use strict";

// Line-6 R4 Repeat Suppression primitive tests (deterministic, no I/O).
// Gates (task book §五): unchanged suppress / changed refresh / new range
// deliver / different file isolation / false_suppression=0 / stale=0 /
// no-guessing on missing info.
// 运行：node --test deploy/hooks/post_tool/read_repeat_suppression.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { decideRepeatRead, mergeRanges, isCoveredBy } = require("./read_repeat_suppression.js");

const H = "aaaabbbbccccdddd1111222233334444";
const req = (over = {}) => ({
  path: "lib/reply.js",
  start_line: 1,
  end_line: 200,
  content_hash: H,
  ...over,
});

test("Case 1: same file + same range + unchanged -> suppress with auditable note", () => {
  const r = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 200]] },
    request: req(),
  });
  assert.equal(r.action, "suppress");
  assert.match(r.note, /lines 1-200 of lib\/reply\.js/);
  assert.match(r.note, /unchanged \(fingerprint aaaabbbb\)/);
  assert.ok(r.note.length < 500, "suppression note is compact, not a content re-send");
});

test("Case 2: same file + content changed -> refresh (never suppress stale)", () => {
  const r = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 200]] },
    request: req({ content_hash: "ffffeeee000011112222333344445555" }),
  });
  assert.equal(r.action, "refresh");
  assert.equal(r.reason, "content_changed");
  assert.equal(r.note, null, "refresh must not carry a suppression note");
});

test("Case 3: same file + unchanged + new range -> deliver unseen", () => {
  const disjoint = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 200]] },
    request: req({ start_line: 201, end_line: 300 }),
  });
  assert.equal(disjoint.action, "deliver_unseen");

  const partialOverlap = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 100]] },
    request: req({ start_line: 50, end_line: 150 }),
  });
  assert.equal(partialOverlap.action, "deliver_unseen", "partially unseen range must deliver");
});

test("Case 4: different file -> normal delivery (isolation)", () => {
  const r = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 200]] },
    request: req({ path: "lib/request.js" }),
  });
  assert.equal(r.action, "deliver");
  assert.equal(r.reason, "different_file");
});

test("false_suppression=0: any fingerprint change forces refresh (same range)", () => {
  for (const other of ["0", "different-hash", H.slice(1) + "x"]) {
    const r = decideRepeatRead({
      previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 200]] },
      request: req({ content_hash: other }),
    });
    assert.notEqual(r.action, "suppress", `hash=${other} must never suppress`);
  }
});

test("no guessing: missing hash or range always delivers", () => {
  const noHash = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 200]] },
    request: req({ content_hash: undefined }),
  });
  assert.equal(noHash.action, "deliver");
  const noRange = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 200]] },
    request: req({ start_line: undefined, end_line: undefined }),
  });
  assert.equal(noRange.action, "deliver");
  const noPrevious = decideRepeatRead({ previous: null, request: req() });
  assert.equal(noPrevious.action, "deliver");
});

test("multi-range union: contiguous coverage suppresses; gap never suppresses unseen lines", () => {
  // Contiguous: 1-100 + 101-200 covers 40-160 completely.
  const contiguous = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 100], [101, 200]] },
    request: req({ start_line: 40, end_line: 160 }),
  });
  assert.equal(contiguous.action, "suppress");

  // GAP (line 101 undelivered): a spanning request must deliver — suppressing
  // would silently hide unseen line 101 (false suppression).
  const gapped = decideRepeatRead({
    previous: { path: "lib/reply.js", content_hash: H, ranges: [[1, 100], [102, 200]] },
    request: req({ start_line: 40, end_line: 160 }),
  });
  assert.equal(gapped.action, "deliver_unseen", "undelivered line inside the request forbids suppression");
});

test("range algebra helpers", () => {
  assert.deepEqual(mergeRanges([[5, 10], [1, 4], [12, 20], [11, 15]]), [[1, 20]]);
  assert.equal(isCoveredBy([[1, 100]], 10, 20), true);
  assert.equal(isCoveredBy([[1, 100]], 90, 120), false);
});
