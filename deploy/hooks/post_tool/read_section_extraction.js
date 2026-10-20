"use strict";

// ============================================================================
// post_tool/read_section_extraction.js — Line-6 R5 Section Extraction primitive
// ============================================================================
// 纯函数、无 I/O、确定性。为 R5（大文档/Spec 定向阅读）任务按章节提取：
//   - 解析 markdown heading（#..####），heading 到下一个同级/更高级 heading 为一节
//   - 按 task_terms 打分（heading 命中权重 3，正文命中权重 1）
//   - 只交付命中章节（heading + 正文 verbatim，lexical fidelity）
//   - 交叉引用扩展：选中章节正文引用了其它章节标题 → 该章节一并纳入（一轮）
//   - 无命中 → null（Native，不猜测、不做全文摘要）
//   - cap：按分数降序填充至 max_chars
// ============================================================================

function parseSections(text) {
  const lines = String(text || "").split(/\r?\n/);
  const headings = [];
  lines.forEach((line, i) => {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) headings.push({ level: m[1].length, title: m[2].trim(), line: i });
  });
  // Flat section model: every heading (any level) opens a section that ends at
  // the next heading of any level — the right granularity for task-relevant
  // extraction (a # title must not swallow the whole document).
  const sections = [];
  for (let h = 0; h < headings.length; h++) {
    const start = headings[h].line;
    const end = h + 1 < headings.length ? headings[h + 1].line : lines.length;
    sections.push({
      level: headings[h].level,
      title: headings[h].title,
      start,
      end,
      body: lines.slice(start, end),
    });
  }
  return { lines, headings, sections };
}

function scoreSection(section, terms) {
  let score = 0;
  const titleLower = section.title.toLowerCase();
  for (const term of terms) {
    const t = String(term || "").toLowerCase().trim();
    if (!t) continue;
    if (titleLower.includes(t)) score += 3;
    if (section.body.some((l) => l.toLowerCase().includes(t))) score += 1;
  }
  return score;
}

/**
 * 提取任务相关章节。无命中 → null（Native）。
 */
function extractRelevantSections({ text, task_terms, max_chars } = {}) {
  const raw = String(text || "");
  const terms = (task_terms || []).map((t) => String(t || "").toLowerCase().trim()).filter(Boolean);
  if (!raw || !terms.length) return null;

  const { lines, sections } = parseSections(raw);
  if (!sections.length) return null;

  const scored = sections
    .map((s) => ({ section: s, score: scoreSection(s, terms) }))
    .filter((s) => s.score > 0);
  if (!scored.length) return null;

  // cross-section expansion (one round): selected bodies referencing other headings
  const selected = new Set(scored.map((s) => s.section.title));
  for (const { section } of scored) {
    for (const s of sections) {
      if (selected.has(s.title)) continue;
      const refRe = new RegExp(`\\b${s.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (section.body.some((l) => refRe.test(l))) selected.add(s.title);
    }
  }

  // chosen = every selected section (hit-scored first, then cross-referenced
  // sections even when their own score is 0 — a dependency pulled in by a
  // selected body must not be lost), ordered by score then document order.
  const scoreOf = new Map(scored.map((s) => [s.section.title, s.score]));
  const docOrder = new Map(sections.map((s, i) => [s.title, i]));
  const chosen = sections
    .filter((s) => selected.has(s.title))
    .map((s) => ({ section: s, score: scoreOf.get(s.title) || 0 }))
    .sort((a, b) => b.score - a.score || docOrder.get(a.section.title) - docOrder.get(b.section.title));

  const cap = Number(max_chars) || 3400;
  const parts = [];
  let total = 0;
  for (const { section } of chosen) {
    const block = section.body.join("\n").trimEnd();
    if (total + block.length > cap && parts.length) break;
    if (block.length > cap && parts.length) break;
    parts.push(block);
    total += block.length + 1;
  }
  if (!parts.length) return null;

  const delivered = parts.join("\n\n");
  const text2 = [
    `[READ_SECTION_EXTRACTION]`,
    `sections: ${chosen.map((c) => c.section.title).join(" | ")}`,
    `note: task-relevant sections only (verbatim); the full document remains available on request`,
    ``,
    delivered,
  ].join("\n");

  return {
    sections: chosen.map((c) => ({ title: c.section.title, score: c.score })),
    raw_chars: raw.length,
    delivered_chars: text2.length,
    text: text2,
  };
}

module.exports = { extractRelevantSections, parseSections, scoreSection };
