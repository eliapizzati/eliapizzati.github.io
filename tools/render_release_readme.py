#!/usr/bin/env python3
"""Render the data-release README (and stage its plots) into the preview tree.

Temporary viewing aid: the release lives on /data3 and its README is Markdown,
so there is no way to read it in a browser without this. Re-run after editing
the README or regenerating any figure.

    python3 tools/render_release_readme.py
"""
import html, pathlib, re, shutil, sys

REL = pathlib.Path("/data3/pizzati/projects/baqaro_release")
DST = pathlib.Path(__file__).resolve().parent.parent / "_preview" / "_release_plots"


def inline(s):
    s = html.escape(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
    return s


def to_html(src):
    out, in_code, in_tbl = [], False, False
    for line in src.split("\n"):
        if line.startswith("```"):
            if in_tbl:
                out.append("</table>"); in_tbl = False
            out.append("</pre>" if in_code else "<pre>")
            in_code = not in_code
            continue
        if in_code:
            out.append(html.escape(line)); continue
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if set("".join(cells)) <= set("-: "):
                continue
            if not in_tbl:
                out.append("<table>"); in_tbl = True
                out.append("<tr>" + "".join(f"<th>{inline(c)}</th>" for c in cells) + "</tr>")
                continue
            out.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in cells) + "</tr>")
            continue
        if in_tbl:
            out.append("</table>"); in_tbl = False
        m = re.match(r"^(#{1,4})\s+(.*)", line)
        if m:
            n = len(m.group(1))
            out.append(f"<h{n}>{inline(m.group(2))}</h{n}>"); continue
        if line.startswith("> "):
            out.append(f"<blockquote>{inline(line[2:])}</blockquote>"); continue
        if re.match(r"^\s*[-*]\s+", line):
            out.append(f"<li>{inline(re.sub(r'^\s*[-*]\s+', '', line))}</li>"); continue
        if line.strip() == "---":
            out.append("<hr>"); continue
        out.append(f"<p>{inline(line)}</p>" if line.strip() else "")
    if in_tbl:
        out.append("</table>")
    return "\n".join(out)


CSS = """
 body{font:15px/1.65 Inter,system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1.5rem;color:#1b1b1b}
 pre{background:#f6f7f4;padding:.9rem 1.1rem;border-radius:.5rem;overflow-x:auto;font-size:13px;line-height:1.45}
 code{background:#f0f1ee;padding:.1em .35em;border-radius:.25em;font-size:.92em}
 pre code{background:none;padding:0}
 table{border-collapse:collapse;margin:1rem 0;font-size:.93em}
 th,td{border:1px solid #ddd;padding:.35rem .6rem;text-align:left;vertical-align:top}
 th{background:#f6f7f4} h1{font-size:1.5rem} h2{font-size:1.2rem;margin-top:2rem}
 h3{font-size:1.05rem;margin-top:1.6rem}
 blockquote{border-left:3px solid #cfd6c0;margin:.8rem 0;padding:.2rem 0 .2rem 1rem;color:#555}
 li{margin-left:1.2rem} hr{border:0;border-top:1px solid #e2e2e2;margin:2rem 0}
 .nav{background:#f6f7f4;padding:.6rem 1rem;border-radius:.5rem;margin-bottom:1.5rem;font-size:.9em}
 figure{margin:0 0 2.5rem} figcaption{font-weight:600;margin-bottom:.4rem}
 figcaption span{font-weight:400;color:#777} img{width:100%;height:auto;border:1px solid #ddd;border-radius:6px}
"""


def main():
    DST.mkdir(parents=True, exist_ok=True)
    readme = REL / "README.md"
    if not readme.exists():
        print(f"no README at {readme}"); return 1

    (DST / "readme.html").write_text(
        f"<!doctype html><meta charset=utf-8><title>BAQARO release README</title>"
        f"<style>{CSS}</style>"
        f'<div class=nav>Rendered from <code>{readme}</code> &middot; '
        f'<a href="./">figures</a></div>\n{to_html(readme.read_text())}\n")'[:-2] + "\n")

    pngs = sorted((REL / "plots").glob("*.png"))
    for p in pngs:
        shutil.copy2(p, DST / p.name)
    rows = "\n".join(
        f'<figure><figcaption>{p.name} <span>{p.stat().st_size/1024:.0f} KB</span></figcaption>'
        f'<a href="{p.name}"><img src="{p.name}" loading="lazy"></a></figure>' for p in pngs)
    (DST / "index.html").write_text(
        f"<!doctype html><meta charset=utf-8><title>BAQARO release plots</title>"
        f"<style>{CSS}</style>"
        f'<div class=nav>Temporary view of <code>{REL}/plots/</code> &middot; '
        f'<a href="readme.html">README</a></div>\n'
        f"<h1>{len(pngs)} figures</h1>\n{rows}\n")
    print(f"  readme.html + {len(pngs)} figures -> {DST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
