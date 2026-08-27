#!/usr/bin/env python3
"""Render this Jekyll site to ``_preview/`` without Ruby.

GitHub Pages builds the real thing; this exists so you can SEE a change before
pushing it. It implements only the Liquid subset the site actually uses --
``include``, ``if``/``else``, ``for``, ``{{ ... }}`` with the ``default`` and
``strip_newlines`` filters -- and shouts if a page reaches for anything else,
rather than silently rendering an empty string where content should be.

    python3 tools/preview.py && (cd _preview && python3 -m http.server)

Not a Jekyll replacement: no plugins, no collections, no Markdown pages. If the
site grows any of those, use a real Jekyll build instead of extending this.
"""

from __future__ import annotations

import datetime as _datetime
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "_preview"

# directories copied verbatim into the preview
ASSET_DIRS = ("assets", "images", "documents", "thesis_webpage")


# ---------------------------------------------------------------------------
# the tiniest YAML that reads this site's front matter and _data files
# ---------------------------------------------------------------------------

def _strip_comment(tok: str) -> str:
    """Drop a trailing ``# comment``, honouring quotes.

    Getting this wrong is not cosmetic: ``paper_url: ""  # arXiv link`` then
    parses as a NON-EMPTY string, so ``{% if site.data.x.paper_url %}`` fires
    and the page renders a link to the comment text. A preview that lies is
    worse than no preview.
    """
    quote = None
    for i, ch in enumerate(tok):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#" and (i == 0 or tok[i - 1] in " \t"):
            return tok[:i]
    return tok


def _scalar(tok: str):
    tok = _strip_comment(tok).strip()
    if not tok:
        return ""
    if tok[0] in "\"'" and tok[-1] == tok[0] and len(tok) > 1:
        inner = tok[1:-1]
        # double-quoted YAML processes backslash escapes; single-quoted does not
        return inner.encode().decode("unicode_escape") if tok[0] == '"' else inner
    if tok in ("true", "false"):
        return tok == "true"
    return tok


def _inline_map(tok: str) -> dict:
    """Parse ``{ a: 1, b: "x, y" }`` -- quote-aware, so commas inside quotes hold."""
    out, buf, depth, quote = {}, "", 0, None
    for ch in tok.strip().lstrip("{").rstrip("}"):
        if quote:
            buf += ch
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote, buf = ch, buf + ch
        elif ch == "," and depth == 0:
            out.update(_kv(buf)); buf = ""
        else:
            buf += ch
    if buf.strip():
        out.update(_kv(buf))
    return out


def _kv(chunk: str) -> dict:
    if ":" not in chunk:
        return {}
    k, v = chunk.split(":", 1)
    return {k.strip(): _scalar(v)}


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _parse_block(lines: list[tuple[int, str]], i: int, indent: int):
    """Parse one block at ``indent``. Returns ``(value, next_index)``.

    Handles the three shapes this site uses: a mapping of scalars, a list of
    scalars, and a list of mappings -- the last one written either inline
    (``- { a: 1 }``) or as an indented block (``- a: 1`` then more keys below).
    """
    # a list?
    if i < len(lines) and lines[i][1].startswith("- "):
        items = []
        while i < len(lines) and lines[i][0] == indent and lines[i][1].startswith("- "):
            body = lines[i][1][2:].strip()
            i += 1
            if body.startswith("{"):
                items.append(_inline_map(body))
            elif ":" in body and not body.split(":", 1)[1].strip().startswith("//"):
                # block map: this key, plus every deeper line that follows
                item = _kv(body)
                child = indent + 2
                while i < len(lines) and lines[i][0] >= child and not lines[i][1].startswith("- "):
                    item.update(_kv(lines[i][1]))
                    i += 1
                items.append(item)
            else:
                items.append(_scalar(body))
        return items, i

    # otherwise a mapping
    out = {}
    while i < len(lines) and lines[i][0] == indent:
        ind, raw = lines[i]
        if ":" not in raw:
            i += 1
            continue
        key, rest = raw.split(":", 1)
        key, rest = key.strip(), rest.strip()

        if rest in (">-", ">", "|", "|-"):
            i += 1
            buf = []
            while i < len(lines) and lines[i][0] > ind:
                buf.append(lines[i][1].strip())
                i += 1
            out[key] = ("\n" if rest.startswith("|") else " ").join(b for b in buf if b)
            continue

        if _strip_comment(rest).strip() == "":
            i += 1
            if i < len(lines) and lines[i][0] > ind:
                out[key], i = _parse_block(lines, i, lines[i][0])
            else:
                out[key] = ""
            continue

        out[key] = _scalar(rest)
        i += 1
    return out, i


def parse_yaml(text: str) -> dict:
    """Enough YAML for this site's front matter and ``_data/*.yml``.

    Deliberately NOT a general parser -- it covers scalars, block scalars,
    lists of scalars, and lists of mappings (inline or indented), because that
    is what the site uses. Anything else should make you reach for real Jekyll.
    """
    lines = []
    for raw in text.replace("\t", "  ").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        lines.append((_indent(raw), raw.strip()))
    if not lines:
        return {}
    value, _ = _parse_block(lines, 0, lines[0][0])
    return value if isinstance(value, dict) else {}


def split_front_matter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    return parse_yaml(text[3:end]), text[end + 4:].lstrip("\n")


# ---------------------------------------------------------------------------
# the Liquid subset
# ---------------------------------------------------------------------------

class LiquidError(RuntimeError):
    pass


def resolve(expr: str, ctx: dict):
    """``site.data.baqaro.code_url`` -> value, or None. Also handles literals."""
    expr = expr.strip()
    if not expr:
        return None
    if expr[0] in "\"'" and expr[-1] == expr[0]:
        return expr[1:-1]
    cur = ctx
    for part in expr.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def apply_filters(value, filters: list[str], ctx: dict):
    for f in filters:
        name, _, arg = f.strip().partition(":")
        name = name.strip()
        if name == "default":
            if value in (None, "", False):
                value = resolve(arg, ctx)
        elif name == "strip_newlines":
            value = re.sub(r"\s*\n\s*", " ", str(value or "")).strip()
        elif name == "date":
            value = _datetime.datetime.now().strftime(arg.strip().strip("\"'"))
        else:
            raise LiquidError(f"unsupported filter {name!r}")
    return value


def render_expr(expr: str, ctx: dict) -> str:
    head, *filters = expr.split("|")
    val = apply_filters(resolve(head, ctx), filters, ctx)
    return "" if val in (None, False) else str(val)


def truthy(cond: str, ctx: dict) -> bool:
    cond = cond.strip()
    for op in ("==", "!="):
        if op in cond:
            lhs, rhs = (resolve(x, ctx) for x in cond.split(op, 1))
            return (lhs == rhs) if op == "==" else (lhs != rhs)
    val = resolve(cond, ctx)
    return bool(val) and val != ""


TAG = re.compile(r"\{%-?\s*(.*?)\s*-?%\}|\{\{\s*(.*?)\s*\}\}", re.S)


def render(template: str, ctx: dict, includes: pathlib.Path) -> str:
    out, pos = [], 0
    stack = []          # (kind, emitting?)

    def emitting() -> bool:
        return all(e for _, e in stack)

    for m in TAG.finditer(template):
        if m.start() < pos:
            # already consumed -- e.g. it lived inside a {% for %} body, which
            # was rendered as a unit. Without this guard finditer walks back
            # into the body, re-emits every {{ ... }} with the loop variable
            # unbound, and drags `pos` backwards: one phantom extra row.
            continue
        if emitting():
            out.append(template[pos:m.start()])
        pos = m.end()
        tag, expr = m.group(1), m.group(2)

        if expr is not None:
            if emitting():
                out.append(render_expr(expr, ctx))
            continue

        word, _, rest = tag.partition(" ")
        if word == "if":
            stack.append(("if", truthy(rest, ctx) if emitting() else False))
        elif word == "unless":
            stack.append(("if", (not truthy(rest, ctx)) if emitting() else False))
        elif word == "else":
            if not stack:
                raise LiquidError("{% else %} outside a conditional")
            kind, on = stack[-1]
            outer = all(e for _, e in stack[:-1])
            stack[-1] = (kind, (not on) and outer)
        elif word == "endif" or word == "endunless":
            stack.pop()
        elif word == "include":
            if emitting():
                out.append(render((includes / rest.strip()).read_text(), ctx, includes))
        elif word == "for":
            var, _, src = rest.partition(" in ")
            items = resolve(src, ctx) or []
            if emitting():
                body_end = template.index("{% endfor %}", pos)
                body = template[pos:body_end]
                for item in items:
                    out.append(render(body, {**ctx, var.strip(): item}, includes))
                pos = body_end + len("{% endfor %}")
        elif word == "endfor":
            pass
        elif word in ("comment", "endcomment", "raw", "endraw"):
            raise LiquidError(f"unsupported tag {word!r}")
        else:
            raise LiquidError(f"unknown tag {tag!r}")

    if emitting():
        out.append(template[pos:])
    if stack:
        raise LiquidError("unclosed conditional")
    return "".join(out)


# ---------------------------------------------------------------------------

def main() -> int:
    config = parse_yaml((ROOT / "_config.yml").read_text())
    data = {p.stem: parse_yaml(p.read_text())
            for p in (ROOT / "_data").glob("*.yml")} if (ROOT / "_data").is_dir() else {}
    site = {**config, "data": data, "time": _datetime.datetime.now().isoformat()}

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()

    for d in ASSET_DIRS:
        src = ROOT / d
        if src.is_dir():
            shutil.copytree(src, OUT / d)

    pages = sorted(p for p in ROOT.glob("*.html"))
    failed = 0
    for page in pages:
        fm, body = split_front_matter(page.read_text())
        if not fm.get("layout"):
            shutil.copy(page, OUT / page.name)
            print(f"  copy    {page.name}")
            continue
        ctx = {"site": site, "page": {**fm, "url": "/" + page.name}}
        try:
            content = render(body, ctx, ROOT / "_includes")
            layout = (ROOT / "_layouts" / f"{fm['layout']}.html").read_text()
            out = render(layout, {**ctx, "content": content}, ROOT / "_includes")
        except (LiquidError, OSError, ValueError) as exc:
            print(f"  FAIL    {page.name}: {exc}")
            failed += 1
            continue
        (OUT / page.name).write_text(out)
        print(f"  render  {page.name}  ({len(out) // 1024} KB)")

    print(f"\n{len(pages) - failed}/{len(pages)} pages -> {OUT}")
    if failed:
        return 1
    print("serve with:  cd _preview && python3 -m http.server")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
