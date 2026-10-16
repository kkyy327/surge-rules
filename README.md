# surge-rules

自用的 Surge / Shadowrocket 聚合分流规则。

上游：[blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script)（28k+ star，每日更新）

## 订阅链接

| 规则 | 用途 | 链接 |
| ---- | ---- | ---- |
| Proxy-1 | 需要代理的网站（1/3） | `https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Proxy-1.list` |
| Proxy-2 | 需要代理的网站（2/3） | `https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Proxy-2.list` |
| Proxy-3 | 需要代理的网站（3/3，Google、Telegram、Twitter、Netflix、AI 服务等共约 9850 条） | `https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Proxy-3.list` |
| Direct | 国内直连（微信、支付宝、银行、京东、B站等，约 3800 条） | `https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Direct.list` |
| Reject | 去广告（精简版，误杀少，约 370 条） | `https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Reject.list` |

## Surge 配置示例

```ini
[Rule]
# 去广告
RULE-SET,https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Reject.list,REJECT
# 国内直连
RULE-SET,https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Direct.list,DIRECT
# 需要代理（Proxy 分三个文件，三个都要订阅）
RULE-SET,https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Proxy-1.list,PROXY
RULE-SET,https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Proxy-2.list,PROXY
RULE-SET,https://cdn.jsdelivr.net/gh/kkyy327/surge-rules@main/rules/Proxy-3.list,PROXY
# 国内 IP 直连
GEOIP,CN,DIRECT
# 兜底
FINAL,DIRECT
```

`FINAL` 用 `DIRECT` 是白名单模式（只有命中 Proxy 的才走代理，省流量）；
想简单粗暴就改成 `FINAL,PROXY`（黑名单模式）。

## Shadowrocket

配置 → 模块/规则 → 添加规则集，分别填上面五个链接，策略对应 REJECT / DIRECT / PROXY。

## 手动补充

`custom/` 目录下三个文件是手工加的规则，每次重新生成都会保留：

- `proxy_custom.list`：上游缺失的手动补（如 `voice.google.com`，上游 GoogleVoice 列表里没有，已手动补上）
- `direct_custom.list` / `reject_custom.list`：按需添加

另外 `scripts/proxy_services.txt` 列了重点服务的专属规则目录（如 OpenAI、Claude、Anthropic），
构建时会自动合并，保证这些服务的域名不被漏掉。

## 更新

上游更新时手动重跑脚本并推送：

```bash
cd ~/workspace/surge-rules-build
python3 scripts/build.py
# 按块逐个推送 rules/*.list
```
