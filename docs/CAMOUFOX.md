# Apple-AutoMation 浏览器说明（Camoufox）

> 官方仓库：https://github.com/daijro/camoufox  
> Python 文档：https://camoufox.com/python

## 模块分工

| 部分 | 职责 | 主要入口 |
| --- | --- | --- |
| **设置** | macOS Apple Account 登录、SMS、后置；与网页 2FA 独立 | `scripts/lib/mac-settings-*.js` |
| **浏览器** | Developer → Account → 改密 → Small Business | `scripts/ruyipage/apple_account_flow.py` |

```text
run.sh → apple-id-full-flow.mjs
      → account-browser-flow.js
      → ruyipage-backend-runner.js（JSONL）
      → apple_account_flow.py
      → camoufox_compat.py / camoufox_session.py
      → Camoufox（Firefox + macOS 指纹）
```

## 固定 tab 顺序

1. 启动 Camoufox（系统默认 profile + 一套 macOS 指纹）
2. **新建 tab** → Developer 登录 / 2FA / 会员
3. **新建 tab** → Account 登录 / 2FA / 个人信息
4. **同 Account tab** → 登录与安全性改密
5. **新建 tab** → Small Business 申请

## 2FA → 浏览器输入

| 步骤 | 谁 | 动作 |
| --- | --- | --- |
| 1 | Python | `prepare_2fa` |
| 2 | Node sidecar | popup/Settings/TTY 准备 |
| 3 | Node → Python | `2fa_prepared` |
| 4 | Python | `need_2fa` + generation |
| 5 | Node | `get2FACode` |
| 6 | Node → Python | `{type:"2fa_code", generation, code}` |
| 7 | Python | `fill_security_code` → Camoufox 兼容层 `human_click` / `type` / `input` |

## 启动契约

1. **Profile**：系统 Firefox 默认 profile（`profiles.ini`）
2. **`--allow-downgrade`**：跨小版本兼容
3. **指纹**：`fingerprint_preset=True` + `os=macos`；persistent context 内多 tab 共用
4. **代理**：默认 Clash `http://127.0.0.1:7890` + `geoip=True`
5. **拟人**：`humanize=True`
6. **通道（默认 dev 源）**：`official/prerelease`（[daijro/camoufox](https://github.com/daijro/camoufox) 最新 FF152 预发布 / beta）。安装时执行 `sync` → `set` → `fetch`。可用 `CAMOUFOX_CHANNEL` 覆盖。

启动前关闭图标打开的 Firefox。

## 安装

```bash
./install.sh
# → .runtime/camoufox-venv
# → pip install camoufox[geoip]（SSL 失败则 --trusted-host + 镜像）
# → camoufox sync
# → camoufox set official/prerelease   # FF152 dev 源
# → camoufox fetch
```

## 兼容层

`camoufox_compat.py` 提供 `eles` / `actions` / `get` / `new_tab` / `tab_id` / `input`，保持 `apple_account_flow.py` 业务选择器与状态机不变。
