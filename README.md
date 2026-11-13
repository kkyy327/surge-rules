# surge-rules

自用的 Surge / Shadowrocket 聚合分流规则。

上游：Proxy / Direct / TikTok / YouTube 取自 [MagicRule](https://magicrule.pages.dev)；Reject 取自 [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script) 的 AdvertisingLite。每 5 天自动检查同步一次。

## 订阅链接

| 规则 | 用途 | 链接 |
| ---- | ---- | ---- |
| Proxy+ | 需要代理的网站（原 Nimbus/Cirrus/Stratus 三片合并） | `https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Proxy+.list` |
| Direct | 国内直连（微信、支付宝、银行、京东、B站等） | `https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Direct.list` |
| Reject | 去广告（精简版，误杀少，约 370 条） | `https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Reject.list` |

## Surge 配置示例

```ini
[Rule]
# 去广告
RULE-SET,https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Reject.list,REJECT
# 国内直连
RULE-SET,https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Direct.list,DIRECT
# 需要代理
RULE-SET,https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Proxy+.list,PROXY
# 国内 IP 直连
GEOIP,CN,DIRECT
# 兜底
FINAL,DIRECT
```

`FINAL` 用 `DIRECT` 是白名单模式（只有命中 Proxy 的才走代理，省流量）；
想简单粗暴就改成 `FINAL,PROXY`（黑名单模式）。

## Shadowrocket

配置 → 模块/规则 → 添加规则集，分别填上面的链接，策略对应 REJECT / DIRECT / PROXY。

## 手动补充

`custom/` 目录下三个文件是手工加的规则，每次重新生成都会保留：

- `proxy_custom.list`：上游缺失的手动补（如 `voice.google.com`，上游 GoogleVoice 列表里没有，已手动补上）
- `direct_custom.list` / `reject_custom.list`：按需添加

另外 `scripts/proxy_services.txt` 列了重点服务的专属规则目录（如 OpenAI、Claude、Anthropic），
构建时会自动合并，保证这些服务的域名不被漏掉。

## 跨集重叠与禁区（维护必读）

- **同源重叠是正常的**：MagicRule 的统计/分析类域名会同一批灌进 Proxy+ 和 Direct，谁生效由引用配置里的规则顺序决定（DirectPlus → Proxy+ → Direct → GEOIP,CN）。不要为了「去重」跨集删改。
- **Twitter 已并入 Proxy+**（2026-11-08），不再单独成集；不要再生成或引用 Twitter.list。
- **Apple 规则已并入 Direct**（2026-11-01），不要再单独引用 Apple 集；AI 集在配置中仍须排在 Direct 之前，Apple 智能才走 AI 策略。
- **海外流媒体集已含 YouTube 规则**；YouTube.list 只在想给 YouTube 单独指定地区时才需要引用。TikTok 集实际只含 TikTok 本体规则。
- **禁区域名，永不拦截、永不加入任何集**：`zijieapi.com`（字节核心 API，拦截会导致短剧 App 白屏）、`dig.bdurl.net`（加入规则集曾导致红果短剧直接崩溃，已撤出）。
- **微信相关域名必须直连且位置靠前**：曾因微信流量走代理被风控冻结（2026-10-17）。

## 更新

上游更新时手动重跑脚本并推送：

```bash
cd ~/workspace/surge-rules-build
python3 scripts/build.py
# 按块逐个推送 rules/*.list
```
