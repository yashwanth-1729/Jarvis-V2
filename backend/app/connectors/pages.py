"""The page the browser lands on after a connector sign-in.

Shown in the user's real browser (not the app), so it carries JARVIS's own
look: the app's surface/ink/accent tokens, the brand mark, and what was
actually connected -- the account and each service -- instead of two lines
of text. It cannot close itself (browsers only let scripts close tabs they
opened), so it says plainly what to do next.
"""

from __future__ import annotations

import html

_MARK = """<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 3 27.25 9.5v13L16 29 4.75 22.5v-13L16 3Z" stroke="currentColor" stroke-width="1.2"/><path d="M16 9v10.5a3.5 3.5 0 0 1-7 0M16 9h6M12 9h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="23" cy="22" r="1.5" fill="currentColor"/></svg>"""

_OK = """<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="11" stroke="currentColor" stroke-width="1.5" opacity=".35"/><path class="tick" d="m7 12.5 3.2 3.2L17 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>"""

_FAIL = """<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="11" stroke="currentColor" stroke-width="1.5" opacity=".35"/><path d="M12 7v6M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>"""

_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · JARVIS</title>
<style>
:root{{--s0:hsl(220 60% 3%);--s1:hsl(218 44% 6%);--line:hsl(214 30% 14%);--ink:hsl(205 30% 96%);
--dim:hsl(205 14% 63%);--accent:hsl(199 100% 57%);--pos:hsl(151 50% 53%);--crit:hsl(358 75% 59%)}}
*{{box-sizing:border-box}}
body{{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;
background:radial-gradient(60rem 40rem at 50% -10%,hsl(199 100% 57% / .10),transparent 60%),var(--s0);
color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}}
.card{{width:100%;max-width:26rem;background:var(--s1);border:1px solid var(--line);border-radius:18px;
padding:28px 26px 24px;box-shadow:0 30px 80px -30px hsl(220 60% 1% / .9);animation:rise .45s cubic-bezier(.2,.8,.2,1)}}
.brand{{display:flex;align-items:center;gap:10px;color:var(--dim);font-size:12px;letter-spacing:.16em;font-weight:600}}
.brand svg{{width:22px;height:22px;color:var(--accent)}}
.status{{width:56px;height:56px;margin:26px 0 14px;color:{tone}}}
.status svg{{width:100%;height:100%}}
.tick{{stroke-dasharray:20;stroke-dashoffset:20;animation:draw .5s .25s ease-out forwards}}
h1{{margin:0;font-size:24px;line-height:1.2;letter-spacing:-.02em;font-weight:650}}
.lead{{margin:8px 0 0;color:var(--dim)}}
.who{{margin:18px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:12px;font-size:14px;word-break:break-all}}
.who span{{display:block;color:var(--dim);font-size:12px;margin-bottom:2px}}
ul{{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:8px}}
li{{padding:6px 11px;border-radius:999px;font-size:13px;border:1px solid hsl(151 50% 53% / .35);color:var(--pos);background:hsl(151 50% 53% / .08)}}
li::before{{content:"✓ ";}}
.next{{margin:22px 0 0;padding-top:16px;border-top:1px solid var(--line);font-size:14px}}
.next b{{color:var(--ink)}}
.muted{{color:var(--dim);font-size:13px;margin-top:6px}}
@keyframes rise{{from{{opacity:0;transform:translateY(10px)}}to{{opacity:1;transform:none}}}}
@keyframes draw{{to{{stroke-dashoffset:0}}}}
@media (prefers-reduced-motion:reduce){{.card,.tick{{animation:none;stroke-dashoffset:0}}}}
</style></head>
<body><main class="card" role="main">
<div class="brand">{mark}JARVIS</div>
<div class="status">{icon}</div>
<h1>{title}</h1>
<p class="lead">{lead}</p>
{details}
<p class="next">{next_step}</p>
</main></body></html>"""


def render(*, ok: bool, title: str, lead: str, account: str = "",
           items: list[str] | None = None, next_step: str = "") -> str:
    details = ""
    if account:
        details += f'<div class="who"><span>Account</span>{html.escape(account)}</div>'
    if items:
        details += "<ul>" + "".join(f"<li>{html.escape(i)}</li>" for i in items) + "</ul>"
    if not next_step:
        next_step = ("<b>You can close this tab</b> and go back to JARVIS."
                     '<span class="muted" style="display:block">It updates by itself within a few seconds.</span>'
                     if ok else "<b>Close this tab</b> and try Connect again in JARVIS settings.")
    return _TEMPLATE.format(
        title=html.escape(title), lead=html.escape(lead), details=details, next_step=next_step,
        mark=_MARK, icon=_OK if ok else _FAIL, tone="var(--pos)" if ok else "var(--crit)",
    )
