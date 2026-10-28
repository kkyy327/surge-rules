#!/usr/bin/env python3
"""聚合 blackmatrix7/ios_rule_script 生成 Proxy / Direct / Reject 三个 Surge 规则集.

用法: python3 build.py
输出: ../rules/Proxy.list ../rules/Direct.list ../rules/Reject.list
"""
import os
import re
import sys
import urllib.request

BASE = "https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Surge"
FALLBACK = "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Surge / Shadowrocket / Loon 通用的可移植规则类型
PORTABLE_TYPES = {"DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "IP-ASN"}

UPSTREAM = "blackmatrix7/ios_rule_script"

# 已从 Proxy 聚合排除的服务：其规则改走专用 RULE-SET，不再混进通用代理集
# （Twitter 已单拆给 𝕏 策略组、TikTok 已单拆给 TikTok 策略组，均指向 blackmatrix7 官方列表）
PROXY_EXCLUDE_SERVICES = ["Twitter", "OpenAI", "Claude", "Anthropic", "YouTube", "TikTok"]


def fetch(url: str) -> str:
    last_err = None
    for u in (url, url.replace(
            "https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master",
            "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master")):
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "surge-rules-builder"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise RuntimeError(f"下载失败 {url}: {last_err}")


def parse(text: str):
    rules = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Z0-9-]+),(.+)$", line)
        if not m:
            continue
        typ, val = m.group(1), m.group(2).strip()
        if typ not in PORTABLE_TYPES:
            continue  # 丢弃 USER-AGENT / PROCESS-NAME 等不可移植类型
        if typ in ("DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD"):
            val = val.lower()
        rules.append((typ, val))
    return rules


def merge_suffix(rules):
    """去重 + DOMAIN-SUFFIX 合并子域名/域名冗余."""
    suffixes = {v for t, v in rules if t == "DOMAIN-SUFFIX"}
    out = []
    seen = set()
    for typ, val in rules:
        if (typ, val) in seen:
            continue
        if typ in ("DOMAIN", "DOMAIN-SUFFIX"):
            # 已被更大的 SUFFIX 覆盖则丢弃
            parts = val.split(".")
            covered = any(".".join(parts[i:]) in suffixes and ".".join(parts[i:]) != val
                          for i in range(1, len(parts)))
            if covered:
                continue
            if typ == "DOMAIN" and val in suffixes:
                continue
        seen.add((typ, val))
        out.append((typ, val))
    # 稳定排序: 类型 -> 值
    order = {"DOMAIN": 0, "DOMAIN-SUFFIX": 1, "DOMAIN-KEYWORD": 2, "IP-CIDR": 3, "IP-CIDR6": 4, "IP-ASN": 5}
    out.sort(key=lambda x: (order.get(x[0], 9), x[1]))
    return out


def service_list_url(service: str) -> str:
    return f"{BASE}/{service}/{service}.list"


def resolve_service_url(service: str) -> str | None:
    """目录下的 .list 文件名不一定与目录名完全一致, 404 时用 API 查找."""
    url = service_list_url(service)
    try:
        fetch(url)
        return url
    except RuntimeError:
        pass
    try:
        api = f"https://api.github.com/repos/{UPSTREAM}/contents/rule/Surge/{service}"
        req = urllib.request.Request(api, headers={"User-Agent": "surge-rules-builder"})
        with urllib.request.urlopen(req, timeout=30) as r:
            import json
            items = json.load(r)
        cands = [x["name"] for x in items
                 if x["type"] == "file" and x["name"].endswith(".list")
                 and "All" not in x["name"] and "Resolve" not in x["name"]]
        if cands:
            return f"{BASE}/{service}/{cands[0]}"
    except Exception as e:  # noqa: BLE001
        print(f"  [跳过] {service}: {e}", file=sys.stderr)
    return None


def load_custom(path: str):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return parse(f.read())


def build(name: str, sources: list[str], custom_file: str, exclude: set | None = None, exclude_domains: set | None = None):
    rules = []
    for src in sources:
        print(f"  拉取 {src}")
        rules.extend(parse(fetch(src)))
    rules.extend(load_custom(os.path.join(ROOT, "custom", custom_file)))
    if exclude:
        before = len(rules)
        rules = [r for r in rules if r not in exclude]
        print(f"  排除命中 {before - len(rules)} 条")
    if exclude_domains:
        before = len(rules)
        def _hit(tv):
            t, v = tv
            if t not in ("DOMAIN", "DOMAIN-SUFFIX"):
                return False
            return any(v == d or v.endswith("." + d) for d in exclude_domains)
        rules = [r for r in rules if not _hit(r)]
        print(f"  域名排除命中 {before - len(rules)} 条")
    merged = merge_suffix(rules)
    counts = {}
    for t, _ in merged:
        counts[t] = counts.get(t, 0) + 1
    header = [
        f"# NAME: {name}",
        f"# REPO: https://github.com/kkyy327/surge-rules",
        f"# UPSTREAM: https://github.com/{UPSTREAM}",
        f"# UPDATED: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
    ]
    for t in ("DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6"):
        if counts.get(t):
            header.append(f"# {t}: {counts[t]}")
    header.append(f"# TOTAL: {len(merged)}")
    header.append("")
    # 按名单固定分块（API 单次推送上限约 128KB，单块须小于该值）
    PARTS = {"Proxy": 3, "Direct": 1, "Reject": 1}
    # Proxy 分块的优美英文名（按字母顺序：晨曦/卷云/层云）
    CHUNK_NAMES = {"Proxy": ["Nimbus", "Cirrus", "Stratus"]}
    nparts = PARTS.get(name, 1)
    body_lines = [f"{t},{v}" for t, v in merged]
    total_size = sum(len(ln) + 1 for ln in body_lines)
    per_chunk = total_size / nparts + 1
    chunks, cur, cur_size = [], [], 0
    for ln in body_lines:
        if cur and cur_size + len(ln) + 1 > per_chunk and len(chunks) < nparts - 1:
            chunks.append(cur)
            cur, cur_size = [], 0
        cur.append(ln)
        cur_size += len(ln) + 1
    if cur:
        chunks.append(cur)

    os.makedirs(os.path.join(ROOT, "rules"), exist_ok=True)
    out_files = []
    for i, part in enumerate(chunks, 1):
        cnames = CHUNK_NAMES.get(name)
        if len(chunks) == 1:
            fname = f"{name}.list"
        elif cnames and i <= len(cnames):
            fname = f"{cnames[i-1]}.list"
        else:
            fname = f"{name}-{i}.list"
        out_path = os.path.join(ROOT, "rules", fname)
        part_header = header + ([f"# PART: {i}/{len(chunks)}"] if len(chunks) > 1 else [])
        with open(out_path, "w", encoding="utf-8") as f:
            f.write("\n".join(part_header) + "\n")
            f.write("\n".join(part) + "\n")
        out_files.append(fname)
        print(f"  -> {out_path}: {len(part)} 条")
    return len(merged), out_files


def main():
    print("== Proxy ==")
    proxy_sources = [f"{BASE}/Proxy/Proxy_All.list"]
    svc_file = os.path.join(ROOT, "scripts", "proxy_services.txt")
    with open(svc_file, encoding="utf-8") as f:
        pservices = [l.strip() for l in f if l.strip() and not l.startswith("#")]
    pok = 0
    for s in pservices:
        url = resolve_service_url(s)
        if url:
            proxy_sources.append(url)
            pok += 1
        else:
            print(f"  [跳过] {s}: 无可用 .list")
    print(f"  重点服务命中 {pok}/{len(pservices)}")
    exclude = set()
    for s in PROXY_EXCLUDE_SERVICES:
        url = resolve_service_url(s)
        if url:
            got = parse(fetch(url))
            exclude.update(got)
            print(f"  排除 {s}: 上游 {len(got)} 条")
    proxy_exclude_domains = set()
    _edf = os.path.join(ROOT, "custom", "proxy_exclude_domains.txt")
    if os.path.exists(_edf):
        with open(_edf, encoding="utf-8") as _f:
            proxy_exclude_domains = {l.strip() for l in _f if l.strip() and not l.startswith("#")}
    _erf = os.path.join(ROOT, "custom", "proxy_exclude_rules.txt")
    if os.path.exists(_erf):
        with open(_erf, encoding="utf-8") as _f:
            for _l in _f:
                _l = _l.strip()
                if _l and not _l.startswith("#"):
                    _p = _l.split(",", 1)
                    if len(_p) == 2:
                        exclude.add((_p[0].strip(), _p[1].strip()))
    n_proxy, proxy_files = build("Proxy", proxy_sources, "proxy_custom.list", exclude=exclude, exclude_domains=proxy_exclude_domains)

    print("== Direct ==")
    direct_sources = [f"{BASE}/ChinaMedia/ChinaMedia.list"]
    svc_file = os.path.join(ROOT, "scripts", "direct_services.txt")
    with open(svc_file, encoding="utf-8") as f:
        services = [l.strip() for l in f if l.strip() and not l.startswith("#")]
    ok = 0
    for s in services:
        url = resolve_service_url(s)
        if url:
            direct_sources.append(url)
            ok += 1
        else:
            print(f"  [跳过] {s}: 无可用 .list")
    print(f"  国内服务命中 {ok}/{len(services)}")
    n_direct, direct_files = build("Direct", direct_sources, "direct_custom.list")

    print("== TikTok（单拆独立集，供引用） ==")
    tk = merge_suffix(parse(fetch(service_list_url("TikTok"))))
    tk_header = [
        "# NAME: TikTok",
        f"# REPO: https://github.com/kkyy327/surge-rules",
        f"# UPSTREAM: https://github.com/{UPSTREAM}",
        f"# UPDATED: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"# TOTAL: {len(tk)}",
        "",
    ]
    with open(os.path.join(ROOT, "rules", "TikTok.list"), "w", encoding="utf-8") as f:
        f.write("\n".join(tk_header))
        f.write("\n".join(f"{t},{v}" for t, v in tk) + "\n")
    print(f"  -> rules/TikTok.list: {len(tk)} 条")

    print("== Reject ==")
    n_reject, reject_files = build("Reject", [f"{BASE}/AdvertisingLite/AdvertisingLite.list"],
                                   "reject_custom.list")

    print(f"\n完成: Proxy={n_proxy} {proxy_files} / Direct={n_direct} {direct_files} / "
          f"Reject={n_reject} {reject_files}")


if __name__ == "__main__":
    main()
