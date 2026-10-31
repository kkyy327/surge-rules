#!/usr/bin/env python3
"""聚合规则生成 Proxy / Direct / Reject / TikTok / YouTube 五个 Surge 规则集.

上游（2026-10-31 起）:
- Proxy / Direct / TikTok / YouTube: MagicRule (https://magicrule.pages.dev)
  抓取方式: /data/index/Surge.json 索引 -> 每集 manifest -> key=rules 的产物文件
- Reject: 保留 blackmatrix7/ios_rule_script 的 AdvertisingLite
  （MagicRule 的 AdvertisingLite 有 18 万条，体积与误杀都不适合本仓库，用户拍板保留旧源）

用法: python3 build.py
输出: ../rules/{Nimbus,Cirrus,Stratus,Direct,Reject,TikTok,YouTube}.list
"""
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Surge / Shadowrocket / Loon 通用的可移植规则类型
PORTABLE_TYPES = {"DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "IP-ASN"}

# ---------- MagicRule ----------
MR_BASE = "https://magicrule.pages.dev"
MR_INDEX = f"{MR_BASE}/data/index/Surge.json"
MR_UPSTREAM_LABEL = "https://magicrule.pages.dev"

# blackmatrix7 时代的服务名 -> MagicRule 的改名/合并
MR_RENAMES = {"Claude": "Anthropic", "BardAI": "Gemini"}
MR_SKIP_SERVICES = {"GoogleSearch", "GoogleDrive"}  # MagicRule 已并入 Google 集

# 已从 Proxy 聚合排除的服务：其规则改走专用 RULE-SET，不再混进通用代理集
PROXY_EXCLUDE_SERVICES = ["Twitter", "OpenAI", "Anthropic", "YouTube", "TikTok"]

# ---------- blackmatrix7（仅 Reject 保留） ----------
BM_BASE = "https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Surge"
BM_UPSTREAM = "blackmatrix7/ios_rule_script"
BM_UPSTREAM_LABEL = "https://github.com/blackmatrix7/ios_rule_script"

# 单文件体积硬上限（推送已改走 push_files，不再受旧的 128KB 参数限制；
# 此上限仅作失控保险，超限即报错停手）
MAX_FILE_BYTES = 400_000


def fetch(url: str) -> str:
    last_err = None
    for _ in range(2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "surge-rules-builder"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise RuntimeError(f"下载失败 {url}: {last_err}")


def bm_fetch(url: str) -> str:
    """blackmatrix7 专用: jsdelivr 失败时回退 raw.githubusercontent."""
    try:
        return fetch(url)
    except RuntimeError:
        raw = url.replace(
            "https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master",
            "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master")
        return fetch(raw)


# ---------- MagicRule 解析 ----------
_mr_index = None
_mr_cache: dict[str, str] = {}


def mr_load_index():
    global _mr_index
    if _mr_index is None:
        data = json.loads(fetch(MR_INDEX))
        _mr_index = {r["name"]: r for r in data["rules"]}
        print(f"  MagicRule 索引: {len(_mr_index)} 集, generated_at={data.get('generated_at')}")
    return _mr_index


def mr_artifact_text(name: str) -> str:
    """集合名 -> 完整规则产物文本（经 manifest 解析当前哈希地址，带缓存）."""
    if name in _mr_cache:
        return _mr_cache[name]
    idx = mr_load_index()
    entry = idx.get(name)
    if entry is None:
        raise RuntimeError(f"MagicRule 无此集合: {name}")
    man = json.loads(fetch(entry["manifest"]))
    art = next((a for a in man["artifacts"] if a.get("key") == "rules"), None)
    if art is None:
        raise RuntimeError(f"MagicRule 集合 {name} 无 rules 产物")
    text = fetch(art["url"])
    _mr_cache[name] = text
    return text


def mr_rules(name: str):
    return parse(mr_artifact_text(name))


def mr_service_name(service: str) -> str | None:
    """把服务清单里的名字映射到 MagicRule 集合名, 不存在返回 None."""
    if service in MR_SKIP_SERVICES:
        return None
    name = MR_RENAMES.get(service, service)
    return name if name in mr_load_index() else None


# ---------- 通用解析/合并（沿用 v1） ----------
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
            parts = val.split(".")
            covered = any(".".join(parts[i:]) in suffixes and ".".join(parts[i:]) != val
                          for i in range(1, len(parts)))
            if covered:
                continue
            if typ == "DOMAIN" and val in suffixes:
                continue
        seen.add((typ, val))
        out.append((typ, val))
    order = {"DOMAIN": 0, "DOMAIN-SUFFIX": 1, "DOMAIN-KEYWORD": 2, "IP-CIDR": 3, "IP-CIDR6": 4, "IP-ASN": 5}
    out.sort(key=lambda x: (order.get(x[0], 9), x[1]))
    return out


def load_custom(path: str):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return parse(f.read())


def write_set(name: str, rules, upstream_label: str, nparts: int = 1, chunk_names=None):
    """合并去重后写出规则集; Proxy 固定 3 块(Nimbus/Cirrus/Stratus), 其余单文件."""
    merged = merge_suffix(rules)
    counts = {}
    for t, _ in merged:
        counts[t] = counts.get(t, 0) + 1
    header = [
        f"# NAME: {name}",
        "# REPO: https://github.com/kkyy327/surge-rules",
        f"# UPSTREAM: {upstream_label}",
        f"# UPDATED: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
    ]
    for t in ("DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6"):
        if counts.get(t):
            header.append(f"# {t}: {counts[t]}")
    header.append(f"# TOTAL: {len(merged)}")
    header.append("")
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
        if len(chunks) == 1:
            fname = f"{name}.list"
        elif chunk_names and i <= len(chunk_names):
            fname = f"{chunk_names[i-1]}.list"
        else:
            fname = f"{name}-{i}.list"
        out_path = os.path.join(ROOT, "rules", fname)
        part_header = header + ([f"# PART: {i}/{len(chunks)}"] if len(chunks) > 1 else [])
        content = "\n".join(part_header) + "\n" + "\n".join(part) + "\n"
        size = len(content.encode("utf-8"))
        if size > MAX_FILE_BYTES:
            raise RuntimeError(f"{fname} 体积 {size} 超过上限 {MAX_FILE_BYTES}, 停手")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(content)
        out_files.append(fname)
        print(f"  -> {out_path}: {len(part)} 条, {size} 字节")
    return len(merged), out_files


def apply_excludes(rules, exclude: set, exclude_domains: set):
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
    return rules


def read_service_file(fname: str):
    with open(os.path.join(ROOT, "scripts", fname), encoding="utf-8") as f:
        return [l.strip() for l in f if l.strip() and not l.startswith("#")]


def main():
    mr_load_index()

    print("== Proxy (MagicRule: Global 系列 + Microsoft/LinkedIn + 重点服务) ==")
    proxy_rules = []
    for coll in ("Global", "GlobalAI", "GlobalGame", "Microsoft", "LinkedIn"):
        got = mr_rules(coll)
        proxy_rules.extend(got)
        print(f"  拉取 {coll}: {len(got)} 条")
    pok = 0
    pservices = read_service_file("proxy_services.txt")
    for s in pservices:
        name = mr_service_name(s)
        if name:
            got = mr_rules(name)
            proxy_rules.extend(got)
            pok += 1
            print(f"  拉取 {s} -> {name}: {len(got)} 条")
        else:
            print(f"  [跳过] {s}: MagicRule 无对应集合")
    print(f"  重点服务命中 {pok}/{len(pservices)}")

    exclude = set()
    for s in PROXY_EXCLUDE_SERVICES:
        got = mr_rules(s)
        exclude.update(got)
        print(f"  排除 {s}: {len(got)} 条")
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
    proxy_rules.extend(load_custom(os.path.join(ROOT, "custom", "proxy_custom.list")))
    proxy_rules = apply_excludes(proxy_rules, exclude, proxy_exclude_domains)
    n_proxy, proxy_files = write_set("Proxy", proxy_rules, MR_UPSTREAM_LABEL,
                                     nparts=3, chunk_names=["Nimbus", "Cirrus", "Stratus"])

    print("== Direct (MagicRule: China + ChinaMedia + Direct + 国内服务) ==")
    direct_rules = []
    for coll in ("China", "ChinaMedia", "Direct"):
        got = mr_rules(coll)
        if coll == "China":
            # China 集自带 3892 条国内 IP-CIDR(约 100KB): 旧构建的 Direct 从无此块,
            # 收进来单文件将超 440KB 且改变直连构成, 故只取域名类规则;
            # ChinaMedia/各服务自带的少量 CIDR 照常保留(与旧构建一致)
            kept = [r for r in got if r[0] not in ("IP-CIDR", "IP-CIDR6")]
            print(f"  拉取 China: {len(got)} 条 (去 IP 段后 {len(kept)} 条)")
            got = kept
        else:
            print(f"  拉取 {coll}: {len(got)} 条")
        direct_rules.extend(got)
    ok = 0
    dservices = read_service_file("direct_services.txt")
    for s in dservices:
        name = mr_service_name(s)
        if name:
            got = mr_rules(name)
            direct_rules.extend(got)
            ok += 1
        else:
            print(f"  [跳过] {s}: MagicRule 无对应集合")
    print(f"  国内服务命中 {ok}/{len(dservices)}")
    direct_rules.extend(load_custom(os.path.join(ROOT, "custom", "direct_custom.list")))
    n_direct, direct_files = write_set("Direct", direct_rules, MR_UPSTREAM_LABEL)

    print("== TikTok（单拆独立集, MagicRule） ==")
    n_tiktok, tiktok_files = write_set("TikTok", mr_rules("TikTok"), MR_UPSTREAM_LABEL)

    print("== YouTube（上游原文整表, MagicRule） ==")
    yt_text = mr_artifact_text("YouTube")
    yt_path = os.path.join(ROOT, "rules", "YouTube.list")
    yt_size = len(yt_text.encode("utf-8"))
    if yt_size > MAX_FILE_BYTES:
        raise RuntimeError(f"YouTube.list 体积 {yt_size} 超过上限, 停手")
    with open(yt_path, "w", encoding="utf-8") as f:
        f.write(yt_text if yt_text.endswith("\n") else yt_text + "\n")
    n_youtube = len([l for l in yt_text.splitlines() if l.strip() and not l.startswith("#")])
    print(f"  -> {yt_path}: {n_youtube} 条, {yt_size} 字节")

    print("== Reject (保留 blackmatrix7: AdvertisingLite) ==")
    reject_rules = parse(bm_fetch(f"{BM_BASE}/AdvertisingLite/AdvertisingLite.list"))
    reject_rules.extend(load_custom(os.path.join(ROOT, "custom", "reject_custom.list")))
    n_reject, reject_files = write_set("Reject", reject_rules, BM_UPSTREAM_LABEL)

    print(f"\n完成: Proxy={n_proxy} {proxy_files} / Direct={n_direct} {direct_files} / "
          f"TikTok={n_tiktok} {tiktok_files} / YouTube={n_youtube} / Reject={n_reject} {reject_files}")


if __name__ == "__main__":
    main()
